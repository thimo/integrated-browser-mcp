import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { CDPManager } from './cdp';
import { BridgeServer } from './http-server';
import { StatusBar } from './status-bar';

const MCP_KEY = 'integrated-browser-mcp';
const STABLE_DIR = path.join(os.homedir(), '.integrated-browser-mcp');
const STABLE_SERVER = path.join(STABLE_DIR, 'mcp-server.mjs');
const INSTANCES_DIR = path.join(STABLE_DIR, 'instances');

let log: vscode.OutputChannel;
let cdp: CDPManager;
let httpServer: BridgeServer;
let statusBar: StatusBar;
let running = false;
let instanceFile: string | null = null;
let actualPort: number | null = null;
let browserLaunching = false;

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
	);

	const config = vscode.workspace.getConfiguration('browserBridge');
	if (config.get<boolean>('autoStart', true)) {
		startBridge(context);
	}
}

async function startBridge(context: vscode.ExtensionContext): Promise<void> {
	if (running) {
		vscode.window.showInformationMessage('Browser MCP is already running.');
		return;
	}

	const config = vscode.workspace.getConfiguration('browserBridge');
	const preferredPort = config.get<number>('httpPort', 3788);

	try {
		// 0. Clean up stale instance files from dead processes
		await cleanStaleInstances();

		// 1. CDP manager
		cdp = new CDPManager(log);
		cdp.onStateChange(state => statusBar.update(state, running, cdp.transport, summarizeTabs()));

		// 2. HTTP server (with lazy browser launch callback)
		httpServer = new BridgeServer(cdp, log);
		httpServer.setEnsureBrowser(url => ensureBrowser(url));
		const port = await httpServer.start(preferredPort);
		actualPort = port;
		running = true;
		statusBar.update(cdp.state, true, cdp.transport, summarizeTabs());

		// 3. Wire BrowserTab lifecycle events when the proposed API is available.
		if (hasProposedBrowserApi()) {
			context.subscriptions.push(
				vscode.window.onDidOpenBrowserTab(tab => {
					// Ignore tabs we're about to open ourselves; adoptBrowserTab is idempotent.
					cdp.adoptBrowserTab(tab).catch(err => {
						log.appendLine(`[Bridge] adoptBrowserTab failed: ${err}`);
					});
				}),
				vscode.window.onDidCloseBrowserTab(tab => {
					cdp.untrackBrowserTab(tab);
					statusBar.update(cdp.state, running, cdp.transport, summarizeTabs());
				}),
				vscode.window.onDidChangeActiveBrowserTab(tab => {
					cdp.syncActive(tab);
					statusBar.update(cdp.state, running, cdp.transport, summarizeTabs());
				}),
			);
			// Adopt any tabs already open at startup.
			for (const existingTab of vscode.window.browserTabs) {
				cdp.adoptBrowserTab(existingTab, existingTab === vscode.window.activeBrowserTab).catch(err => {
					log.appendLine(`[Bridge] Startup adoptBrowserTab failed: ${err}`);
				});
			}
		} else {
			// Fallback: if a browser debug session is already active, adopt it.
			const existingSession = vscode.debug.activeDebugSession && isBrowserSession(vscode.debug.activeDebugSession)
				? vscode.debug.activeDebugSession
				: undefined;
			if (existingSession) {
				await cdp.adoptDebugSession(existingSession);
			}
			// Otherwise, browser will be launched lazily on first request.
		}

		// 4. Register this instance for MCP discovery
		await registerInstance(port);

		// 5. Sync MCP server and configure Claude
		await syncMcpServer(context);
		await configureClaude();

		log.appendLine(`[Bridge] Started successfully on port ${port}`);
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
				} else if (state === 'disconnected' && !browserLaunching) {
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
	actualPort = null;
	await cdp?.dispose();
	await httpServer?.stop();
	await unregisterInstance();
	statusBar?.update('disconnected', false, null, { count: 0 });
	log?.appendLine('[Bridge] Stopped');
}

function hasProposedBrowserApi(): boolean {
	// The `browser` proposed API adds `openBrowserTab` on vscode.window.
	// Absent unless VS Code was launched with --enable-proposed-api=thimo.integrated-browser-mcp.
	return typeof (vscode.window as unknown as { openBrowserTab?: unknown }).openBrowserTab === 'function';
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

async function registerInstance(port: number): Promise<void> {
	const workspace = getWorkspacePath();
	const id = instanceId(workspace);
	const data = {
		port,
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

		await fs.promises.writeFile(claudeSettingsPath, JSON.stringify(config, null, 2) + '\n');
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
	if (!running) {
		vscode.window.showErrorMessage('Browser Bridge is not running.');
		return;
	}
	try {
		if (hasProposedBrowserApi()) {
			await cdp.openTab(url, true);
			return;
		}
		// Fallback path: ensure a tab exists, navigate active.
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
	const port = actualPort ?? 'none';
	const tabs = cdp?.tabCount ?? 0;

	vscode.window.showInformationMessage(
		`Browser MCP: CDP ${cdpState} (${transport}), HTTP on ${port} (${serverState}), ${tabs} tab(s)`,
	);
}

export function deactivate() {
	return stopBridge();
}
