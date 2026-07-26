import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { CDPManager, hasProposedBrowserApi } from './cdp';
import { BridgeServer } from './http-server';
import { StatusBar } from './status-bar';
import { registerLanguageModelTools } from './lm-tools';

const MCP_KEY = 'integrated-browser-mcp';
const STABLE_DIR = path.join(os.homedir(), '.integrated-browser-mcp');
const STABLE_SERVER = path.join(STABLE_DIR, 'mcp-server.mjs');
const INSTANCES_DIR = path.join(STABLE_DIR, 'instances');
const SOCKETS_DIR = path.join(STABLE_DIR, 'sockets');

let log: vscode.OutputChannel;
let cdp: CDPManager;
let httpServer: BridgeServer;
let statusBar: StatusBar;
let running = false;
let instanceFile: string | null = null;
let actualEndpoint: { socketPath?: string; port?: number } = {};
let browserLaunching = false;
// Subscriptions created per start (the browser-tab lifecycle listeners).
// Disposed by stopBridge so a stopped bridge stops firing handlers that deref
// the now-null `cdp`, and so start->stop->start does not accumulate duplicates.
let startDisposables: vscode.Disposable[] = [];
// Fired after the bundled MCP server file is synced, so the VS Code MCP provider
// (registered at activation) re-resolves once the file exists.
let mcpDidChange: vscode.EventEmitter<void> | null = null;

function isBrowserSession(session: vscode.DebugSession): boolean {
	return session.type === 'pwa-editor-browser'
		|| session.type === 'editor-browser'
		|| session.type === 'pwa-chrome'
		|| session.type === 'chrome';
}

function getWorkspacePath(): string {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function instanceId(workspacePath: string): string {
	// Use PID as fallback when no workspace folder is open to avoid collisions
	const key = workspacePath || `pid-${process.pid}`;
	return crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
}

export function activate(context: vscode.ExtensionContext) {
	log = vscode.window.createOutputChannel('Integrated Browser MCP');
	statusBar = new StatusBar();

	context.subscriptions.push(
		log,
		statusBar,
		vscode.commands.registerCommand('browserBridge.start', () => startBridge(context)),
		vscode.commands.registerCommand('browserBridge.stop', stopBridge),
		vscode.commands.registerCommand('browserBridge.status', showStatus),
		vscode.commands.registerCommand('browserBridge.openInBrowser', (uri?: vscode.Uri) => openInBrowser(uri)),
		vscode.debug.onDidStartDebugSession(session => {
			// Auto-connect to externally launched browser child sessions on the
			// fallback (websocket) path. Skip root sessions (no CDP), skip if
			// launchBrowser() is handling it, and skip if we already have tabs.
			if (isBrowserSession(session) && session.parentSession && cdp && cdp.tabCount === 0 && !browserLaunching) {
				cdp.adoptDebugSession(session).catch(err => {
					log.appendLine(`[Bridge] Auto-connect failed: ${err}`);
				});
			}
		}),
		vscode.debug.onDidTerminateDebugSession(session => {
			// On the fallback path, a single debug session drives the single tab.
			// When that session terminates, close the tab so state matches reality.
			if (!cdp || cdp.transport !== 'websocket') return;
			const tab = cdp.getTab('tab-main');
			if (tab?.sessionId === session.id) {
				cdp.closeTab('tab-main').catch(err => {
					log.appendLine(`[Bridge] Close on debug terminate failed: ${err}`);
				});
			}
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			// Re-apply or clear indicators immediately. Without this, switching
			// the setting off would leave every already-marked page carrying a
			// modified title until it happened to be reopened.
			if (event.affectsConfiguration('browserBridge.tabIndicator')
				|| event.affectsConfiguration('browserBridge.tabIndicatorText')) {
				cdp?.refreshIndicators().catch(err => log.appendLine(`[Bridge] Indicator refresh failed: ${err}`));
			}
		}),
	);

	// Contribute the buffer tools VS Code's own browser toolset lacks. Done at
	// activation (not per-start) so they exist regardless of bridge state; each
	// reports cleanly when the bridge is stopped.
	registerLanguageModelTools(context, () => cdp, log);

	// Offer the bundled MCP server to VS Code-hosted MCP clients. Registered at
	// activation per the API contract (contributes.mcpServerDefinitionProviders +
	// this call), and once for the extension lifetime so stop/start can't
	// double-register the same id.
	registerMcpProvider(context);

	const config = vscode.workspace.getConfiguration('browserBridge');
	if (config.get<boolean>('autoStart', true)) {
		startBridge(context);
	}
}

/**
 * Where the bridge's control socket lives. A unix socket on POSIX, a named
 * pipe on Windows. Keyed by workspace so multiple VS Code windows coexist
 * without the port-scanning dance TCP required.
 */
function socketPathFor(id: string): string {
	if (process.platform === 'win32') {
		// Named pipes are not filesystem objects; the namespace is not
		// world-writable and there is no directory to protect.
		return `\\\\.\\pipe\\integrated-browser-mcp-${id}`;
	}
	// Deliberately not os.tmpdir(): it is world-writable with a predictable
	// name, so another local user could pre-create the path (denial of
	// service, or worse if they create it as a socket and accept on it).
	// SOCKETS_DIR is created 0700 before any bind, which also closes the
	// window between listen() and chmod where the socket sat at default
	// permissions.
	return path.join(SOCKETS_DIR, `${id}.sock`);
}

/** Create the socket directory owner-only before anything binds inside it. */
async function ensureSocketsDir(): Promise<void> {
	if (process.platform === 'win32') return;
	await fs.promises.mkdir(SOCKETS_DIR, { recursive: true, mode: 0o700 });
	// mkdir's mode is masked by umask, and the directory may predate this
	// version, so assert the mode rather than assume it.
	await fs.promises.chmod(SOCKETS_DIR, 0o700).catch(() => undefined);
}

/**
 * Prefer a socket/pipe (no listening port at all); fall back to TCP when it
 * cannot be created, or when the user pins `browserBridge.transport` to tcp.
 * TCP is still needed when the MCP client cannot reach the extension host's
 * filesystem — though instance discovery already assumes it can.
 */
async function listenBest(
	server: BridgeServer,
	config: vscode.WorkspaceConfiguration,
	preferredPort: number,
): Promise<{ socketPath?: string; port?: number }> {
	const mode = config.get<string>('transport', 'auto');
	if (mode !== 'tcp') {
		try {
			await ensureSocketsDir();
			const socketPath = await server.startOnSocket(socketPathFor(instanceId(getWorkspacePath())));
			return { socketPath };
		} catch (err) {
			if (mode === 'socket') throw err;
			log.appendLine(`[Bridge] Socket transport unavailable (${err}); falling back to TCP`);
		}
	}
	return { port: await server.start(preferredPort) };
}

async function startBridge(context: vscode.ExtensionContext): Promise<void> {
	if (running) {
		vscode.window.showInformationMessage('Browser MCP is already running.');
		return;
	}

	const config = vscode.workspace.getConfiguration('browserBridge');
	const preferredPort = config.get<number>('httpPort', 3788);

	try {
		// 0. Publish the current MCP server first. A client (e.g. Claude Code)
		// starting alongside VS Code spawns whatever build is on disk at that
		// instant; syncing before the bridge comes up shrinks the window in
		// which it picks up the previous one — which matters now that the
		// transport can change between builds.
		await syncMcpServer(context);
		// The server file now exists; tell VS Code's MCP provider to re-resolve
		// (it was registered at activation, possibly before this sync).
		mcpDidChange?.fire();

		// 1. Clean up stale instance files from dead processes
		await cleanStaleInstances();

		// 2. CDP manager
		cdp = new CDPManager(log);
		cdp.onStateChange(state => statusBar.update(state, running, cdp.transport, summarizeTabs()));

		// 3. HTTP server (socket-first, TCP fallback)
		httpServer = new BridgeServer(cdp, log);
		httpServer.setEnsureBrowser(url => ensureBrowser(url));
		actualEndpoint = await listenBest(httpServer, config, preferredPort);
		running = true;
		statusBar.update(cdp.state, true, cdp.transport, summarizeTabs());

		// 4. Wire BrowserTab lifecycle events when the proposed API is available.
		//    Any failure here is downgraded to the fallback path rather than
		//    failing startup: the bridge is fully functional without the
		//    proposal (single tab, no worker events), so a proposal that is
		//    declared but not granted must not take the whole bridge down.
		let proposedApiWired = false;
		if (hasProposedBrowserApi()) {
			try {
				// Per-start subscriptions: each guards on `cdp` because stopBridge
				// nulls it, and a browser-tab event can still fire between the null
				// and dispose() completing. Tracked in startDisposables so stop
				// removes them (no leak, no post-stop TypeError).
				startDisposables.push(
					vscode.window.onDidOpenBrowserTab(tab => {
						if (!cdp) return;
						// Ignore tabs we're about to open ourselves; adoptBrowserTab is idempotent.
						cdp.adoptBrowserTab(tab).catch(err => {
							log.appendLine(`[Bridge] adoptBrowserTab failed: ${err}`);
						});
					}),
					vscode.window.onDidCloseBrowserTab(tab => {
						if (!cdp) return;
						cdp.untrackBrowserTab(tab);
						statusBar.update(cdp.state, running, cdp.transport, summarizeTabs());
					}),
					vscode.window.onDidChangeActiveBrowserTab(tab => {
						if (!cdp) return;
						cdp.syncActive(tab);
						statusBar.update(cdp.state, running, cdp.transport, summarizeTabs());
					}),
					// url/title/icon changes arrive as a push, so navigation
					// settling needs no polling and no extra CDP round-trip.
					vscode.window.onDidChangeBrowserTabState(tab => {
						if (!cdp) return;
						cdp.notifyBrowserTabState(tab);
						statusBar.update(cdp.state, running, cdp.transport, summarizeTabs());
					}),
				);
				// Adopt any tabs already open at startup.
				for (const existingTab of vscode.window.browserTabs) {
					cdp.adoptBrowserTab(existingTab, existingTab === vscode.window.activeBrowserTab).catch(err => {
						log.appendLine(`[Bridge] Startup adoptBrowserTab failed: ${err}`);
					});
				}
				proposedApiWired = true;
			} catch (err) {
				log.appendLine(`[Bridge] Proposed browser API declared but not granted, falling back: ${err}`);
			}
		}

		if (!proposedApiWired) {
			// Fallback: if a browser debug session is already active, adopt it.
			const existingSession = vscode.debug.activeDebugSession && isBrowserSession(vscode.debug.activeDebugSession)
				? vscode.debug.activeDebugSession
				: undefined;
			if (existingSession) {
				await cdp.adoptDebugSession(existingSession);
			}
			// Otherwise, browser will be launched lazily on first request.
		}

		// 5. Register this instance for MCP discovery
		await registerInstance(actualEndpoint);

		// 6. Configure Claude (server already synced above). The VS Code MCP
		//    provider is registered once at activation, not here.
		await configureClaude();

		log.appendLine(`[Bridge] Started successfully on ${actualEndpoint.socketPath ?? `port ${actualEndpoint.port}`}`);
	} catch (err) {
		log.appendLine(`[Bridge] Failed to start: ${err}`);
		vscode.window.showErrorMessage(`Browser MCP failed to start: ${err}`);
		await stopBridge();
	}
}

/**
 * Ensure at least one tab exists and is connected. Called by `/navigate` and
 * other interaction endpoints on first use. When `url` is provided and the
 * proposed API is available, open the tab directly to that URL to avoid an
 * about:blank flash.
 */
async function ensureBrowser(url?: string): Promise<void> {
	if (cdp?.state === 'connected') return;
	if (browserLaunching || cdp?.state === 'connecting') {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				disposable.dispose();
				reject(new Error('Timed out waiting for browser connection'));
			}, 45000);
			const disposable = cdp.onStateChange(state => {
				if (state === 'connected') {
					clearTimeout(timeout);
					disposable.dispose();
					resolve();
				} else if (state === 'disconnected' && !browserLaunching && cdp.tabCount === 0) {
					// Only fail when there's nothing attached at all. Tabs in
					// mid-adoption can transiently emit 'disconnected' during
					// bootstrap — those aren't hard failures, they'll flip to
					// 'connected' once enableDomains finishes. Falling through
					// to the outer timeout is safer than rejecting eagerly.
					clearTimeout(timeout);
					disposable.dispose();
					reject(new Error('Browser connection failed'));
				}
			});
			if (cdp?.state === 'connected') {
				clearTimeout(timeout);
				disposable.dispose();
				resolve();
			}
		});
		return;
	}
	browserLaunching = true;
	try {
		await launchBrowser(url);
	} finally {
		browserLaunching = false;
	}
}

function summarizeTabs(): { count: number; activeUrl?: string } {
	const active = cdp?.activeTabId ? cdp.getTab(cdp.activeTabId) : undefined;
	return { count: cdp?.tabCount ?? 0, activeUrl: active?.url };
}

async function stopBridge(): Promise<void> {
	running = false;
	actualEndpoint = {};
	// Dispose per-start subscriptions first: they deref `cdp`, so they must stop
	// firing before it is torn down and nulled.
	for (const d of startDisposables) {
		try { d.dispose(); } catch { /* already disposed */ }
	}
	startDisposables = [];
	// Stop accepting requests before tearing down CDP, so no request runs against
	// a half-disposed manager. Guard each await so a failure in one step can't
	// leave the other resource un-torn-down (and cdp non-null).
	try { await httpServer?.stop(); } catch (err) { log?.appendLine(`[Bridge] httpServer.stop failed: ${err}`); }
	try { await cdp?.dispose(); } catch (err) { log?.appendLine(`[Bridge] cdp.dispose failed: ${err}`); }
	// Null it out: the contributed LM tools hold a getter for this and would
	// otherwise keep reading a disposed CDPManager after a stop.
	cdp = undefined as unknown as CDPManager;
	await unregisterInstance().catch(() => undefined);
	statusBar?.update('disconnected', false, null, { count: 0 });
	log?.appendLine('[Bridge] Stopped');
}

async function launchBrowserViaProposedApi(): Promise<boolean> {
	try {
		log.appendLine('[Bridge] Launching via proposed browser API (openBrowserTab: about:blank)');
		// Always open about:blank; the caller (e.g. /navigate handler) does the
		// real navigation once the tab is connected.
		await cdp.openTab('about:blank', true);
		return true;
	} catch (err) {
		log.appendLine(`[Bridge] Proposed API launch failed: ${err}`);
		return false;
	}
}

async function launchBrowser(_lazyUrl?: string): Promise<void> {
	// The URL hint is currently unused for the proposed-API path (we always
	// open about:blank and let the caller navigate). The debug-session path
	// bakes it into the launch config so the very first page load is the
	// target — one fewer navigation round-trip.
	const initialUrl = _lazyUrl ?? 'about:blank';

	// Prefer VS Code's proposed `browser` API when available — it bypasses
	// vscode-js-debug entirely, eliminating the event-forwarding limitations
	// that prevent worker/service-worker events from reaching us.
	if (hasProposedBrowserApi()) {
		const ok = await launchBrowserViaProposedApi();
		if (ok) return;
		log.appendLine('[Bridge] Falling back to debug-session launch');
	}

	// Fallback: launch an editor-browser debug session and bridge via requestCDPProxy.
	// vscode-js-debug creates a root session (the launcher) and a child session
	// for each page target. requestCDPProxy only works on the child session
	// which has the actual CDP connection.
	let disposed = false;
	let timeout: ReturnType<typeof setTimeout>;
	let disposable: vscode.Disposable;

	const childPromise = new Promise<vscode.DebugSession | null>((resolve) => {
		timeout = setTimeout(() => {
			disposable.dispose();
			log.appendLine('[Bridge] Timed out waiting for child browser session');
			resolve(null);
		}, 15000);
		disposable = vscode.debug.onDidStartDebugSession(session => {
			if (isBrowserSession(session) && session.parentSession) {
				log.appendLine(`[Bridge] Child session started: ${session.name} (parent: ${session.parentSession.name})`);
				disposed = true;
				clearTimeout(timeout);
				disposable.dispose();
				resolve(session);
			}
		});
	});

	const config = vscode.workspace.getConfiguration('browserBridge');
	const browserType = config.get<string>('browserType', 'editor-browser');

	const launched = await vscode.debug.startDebugging(undefined, {
		type: browserType,
		request: 'launch',
		name: 'Browser MCP',
		url: initialUrl,
		internalConsoleOptions: 'neverOpen',
	}, {
		noDebug: true,
		suppressDebugToolbar: true,
		suppressDebugView: true,
		suppressDebugStatusbar: true,
	} as vscode.DebugSessionOptions);
	if (!launched) {
		if (!disposed) {
			clearTimeout(timeout!);
			disposable!.dispose();
		}
		log.appendLine('[Bridge] Failed to launch browser session');
		return;
	}

	const session = await childPromise;
	if (!session) {
		log.appendLine('[Bridge] No child browser session started');
		return;
	}

	try {
		await cdp.adoptDebugSession(session);
	} catch (err) {
		log.appendLine(`[Bridge] CDP connect error: ${err}`);
	}
}

/**
 * Publish the bundled MCP server through VS Code's own registry.
 *
 * Complements — does not replace — the `~/.claude.json` write, which the
 * Claude Code CLI still needs. Clients hosted inside VS Code can discover the
 * bridge from here instead, so we reach into fewer files we do not own.
 * Feature-detected: the API is stable in 1.101+ but this extension supports
 * older builds.
 */
function registerMcpProvider(context: vscode.ExtensionContext): void {
	const lm = vscode.lm as unknown as { registerMcpServerDefinitionProvider?: unknown };
	if (typeof lm.registerMcpServerDefinitionProvider !== 'function') return;
	try {
		// Registered at activation, but STABLE_SERVER is written by syncMcpServer
		// during startBridge (which may run later, or not at all with
		// autoStart:false). Fire this after the sync so VS Code re-resolves the
		// definition once the server file actually exists, instead of caching a
		// missing path.
		mcpDidChange = new vscode.EventEmitter<void>();
		// Requires the matching contributes.mcpServerDefinitionProviders entry in
		// package.json (id 'integratedBrowserMcp'); without it this call throws.
		context.subscriptions.push(
			mcpDidChange,
			vscode.lm.registerMcpServerDefinitionProvider('integratedBrowserMcp', {
				onDidChangeMcpServerDefinitions: mcpDidChange.event,
				provideMcpServerDefinitions: () => [
					new vscode.McpStdioServerDefinition('Integrated Browser', 'node', [STABLE_SERVER]),
				],
			}),
		);
		log.appendLine('[MCP] Registered server definition with VS Code');
	} catch (err) {
		log.appendLine(`[MCP] Server definition provider unavailable: ${err}`);
	}
}

async function cleanStaleInstances(): Promise<void> {
	try {
		await fs.promises.mkdir(INSTANCES_DIR, { recursive: true });
		const files = await fs.promises.readdir(INSTANCES_DIR);
		for (const file of files) {
			if (!file.endsWith('.json')) continue;
			const filePath = path.join(INSTANCES_DIR, file);
			try {
				const data = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
				// Check if the process is still alive
				try {
					process.kill(data.pid, 0); // signal 0 = just check existence
				} catch {
					// Process is dead, remove stale file
					await fs.promises.unlink(filePath);
					log.appendLine(`[Bridge] Cleaned stale instance: ${file}`);
				}
			} catch {
				// Corrupt file, remove it
				await fs.promises.unlink(filePath);
			}
		}
	} catch {
		// Instances dir doesn't exist yet
	}
}

async function registerInstance(endpoint: { socketPath?: string; port?: number }): Promise<void> {
	const workspace = getWorkspacePath();
	const id = instanceId(workspace);
	const data = {
		...endpoint,
		workspace,
		pid: process.pid,
		startedAt: new Date().toISOString(),
	};
	try {
		await fs.promises.mkdir(INSTANCES_DIR, { recursive: true });
		instanceFile = path.join(INSTANCES_DIR, `${id}.json`);
		await fs.promises.writeFile(instanceFile, JSON.stringify(data, null, 2));
		log.appendLine(`[Bridge] Registered instance: ${instanceFile}`);
	} catch (err) {
		log.appendLine(`[Bridge] Failed to register instance: ${err}`);
	}
}

async function unregisterInstance(): Promise<void> {
	if (instanceFile) {
		try {
			await fs.promises.unlink(instanceFile);
		} catch {
			// Already gone
		}
		instanceFile = null;
	}
}

async function syncMcpServer(context: vscode.ExtensionContext): Promise<void> {
	const bundled = path.join(context.extensionPath, 'dist', 'mcp-server.mjs');
	try {
		await fs.promises.mkdir(STABLE_DIR, { recursive: true });
		await fs.promises.copyFile(bundled, STABLE_SERVER);
		log.appendLine(`[MCP] Synced server to ${STABLE_SERVER}`);
	} catch (err) {
		log.appendLine(`[MCP] Failed to sync server: ${err}`);
	}
}

async function configureClaude(): Promise<void> {
	const claudeSettingsPath = path.join(os.homedir(), '.claude.json');
	try {
		let config: Record<string, unknown> = {};
		try {
			const raw = await fs.promises.readFile(claudeSettingsPath, 'utf-8');
			config = JSON.parse(raw);
		} catch {
			// File doesn't exist yet
		}

		const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;

		const desired = { command: 'node', args: [STABLE_SERVER] };
		const existing = mcpServers[MCP_KEY] as { command?: string; args?: string[]; env?: unknown } | undefined;
		if (existing?.command === desired.command
			&& existing?.args?.[0] === desired.args[0]
			&& existing?.args?.length === 1
			&& !existing.env) {
			log.appendLine('[MCP] Claude already configured');
			return;
		}

		mcpServers[MCP_KEY] = desired;
		config.mcpServers = mcpServers;

		// Atomic write: stage to a tmp file in the same directory, then
		// rename on top. If two VS Code windows boot simultaneously they can
		// both read-modify-write ~/.claude.json and the later one would
		// clobber the earlier one's changes. Rename is atomic on POSIX, so
		// the worst outcome is that one window's write is superseded — no
		// half-written file, no lost unrelated keys (both writes compute
		// from the same on-disk state and both add the same MCP entry).
		const tmpPath = `${claudeSettingsPath}.${process.pid}.${Date.now()}.tmp`;
		await fs.promises.writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n');
		await fs.promises.rename(tmpPath, claudeSettingsPath);
		log.appendLine(`[MCP] Configured Claude MCP in ${claudeSettingsPath}`);
	} catch (err) {
		log.appendLine(`[MCP] Failed to configure Claude: ${err}`);
	}
}

/**
 * Explorer/editor context menu command: open the clicked resource in the
 * integrated browser. Uses the proposed-API `openTab` path when available
 * (keeps any existing tab open) and falls back to navigating the active
 * tab on the debug-session path.
 */
async function openInBrowser(uri?: vscode.Uri): Promise<void> {
	if (!uri) {
		const active = vscode.window.activeTextEditor?.document.uri;
		if (!active) {
			vscode.window.showErrorMessage('Open in Integrated Browser: no file selected.');
			return;
		}
		uri = active;
	}
	const url = uri.toString();
	if (!cdp) {
		vscode.window.showErrorMessage('Browser Bridge is not active in this window. Run "Browser Bridge: Start" from the Command Palette.');
		return;
	}
	try {
		if (hasProposedBrowserApi()) {
			await cdp.openTab(url, true);
			return;
		}
		// Fallback path: lazy-launch if needed, then navigate active tab.
		await ensureBrowser(url);
		const tab = cdp.getTab();
		if (!tab) {
			vscode.window.showErrorMessage('No active browser tab to navigate.');
			return;
		}
		await tab.send('Page.navigate', { url });
	} catch (err) {
		vscode.window.showErrorMessage(`Open in Integrated Browser failed: ${err instanceof Error ? err.message : err}`);
	}
}

function showStatus(): void {
	const cdpState = cdp?.state ?? 'disconnected';
	const transport = cdp?.transport ?? 'none';
	const serverState = running ? 'running' : 'stopped';
	const endpoint = actualEndpoint.socketPath ?? actualEndpoint.port ?? 'none';
	const tabs = cdp?.tabCount ?? 0;

	vscode.window.showInformationMessage(
		`Browser MCP: CDP ${cdpState} (${transport}), API on ${endpoint} (${serverState}), ${tabs} tab(s)`,
	);
}

export function deactivate() {
	return stopBridge();
}
