import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as net from 'net';
import * as crypto from 'crypto';
import { CDPConnection } from './cdp';
import { BridgeServer } from './http-server';
import { StatusBar } from './status-bar';

const MCP_KEY = 'vscode-browser-bridge';
const STABLE_DIR = path.join(os.homedir(), '.vscode-browser-bridge');
const STABLE_SERVER = path.join(STABLE_DIR, 'mcp-server.mjs');
const INSTANCES_DIR = path.join(STABLE_DIR, 'instances');

let log: vscode.OutputChannel;
let cdp: CDPConnection;
let httpServer: BridgeServer;
let statusBar: StatusBar;
let running = false;
let instanceFile: string | null = null;
let actualPort: number | null = null;
let browserLaunching = false;

function findFreePort(startPort: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', () => {
			if (startPort < 65535) {
				resolve(findFreePort(startPort + 1));
			} else {
				reject(new Error('No free port found'));
			}
		});
		server.once('listening', () => {
			server.close();
			resolve(startPort);
		});
		server.listen(startPort, '127.0.0.1');
	});
}

function isBrowserSession(session: vscode.DebugSession): boolean {
	return session.type === 'pwa-editor-browser'
		|| session.type === 'editor-browser';
}

function getWorkspacePath(): string {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function instanceId(workspacePath: string): string {
	return crypto.createHash('md5').update(workspacePath).digest('hex').slice(0, 12);
}

export function activate(context: vscode.ExtensionContext) {
	log = vscode.window.createOutputChannel('Browser Bridge');
	statusBar = new StatusBar();

	context.subscriptions.push(
		log,
		statusBar,
		vscode.commands.registerCommand('browserBridge.start', () => startBridge(context)),
		vscode.commands.registerCommand('browserBridge.stop', stopBridge),
		vscode.commands.registerCommand('browserBridge.status', showStatus),
		vscode.debug.onDidStartDebugSession(session => {
			if (isBrowserSession(session) && cdp?.state === 'disconnected') {
				cdp.connectToSession(session);
			}
		}),
		vscode.debug.onDidTerminateDebugSession(session => {
			if (isBrowserSession(session)) {
				cdp?.disconnect();
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
		vscode.window.showInformationMessage('Browser Bridge is already running.');
		return;
	}

	const config = vscode.workspace.getConfiguration('browserBridge');
	const preferredPort = config.get<number>('httpPort', 3788);

	try {
		// 0. Clean up stale instance files from dead processes
		await cleanStaleInstances();

		const port = await findFreePort(preferredPort);
		actualPort = port;

		// 1. CDP connection
		cdp = new CDPConnection(log);
		cdp.onStateChange(state => statusBar.update(state, running));

		// 2. HTTP server (with lazy browser launch callback)
		httpServer = new BridgeServer(cdp, log);
		httpServer.setEnsureBrowser(() => ensureBrowser());
		await httpServer.start(port);
		running = true;
		statusBar.update(cdp.state, true);

		// 3. If a browser session already exists, connect to it (don't launch a new one)
		const existingSession = vscode.debug.activeDebugSession && isBrowserSession(vscode.debug.activeDebugSession)
			? vscode.debug.activeDebugSession
			: undefined;

		if (existingSession) {
			await cdp.connectToSession(existingSession);
		}
		// Otherwise, browser will be launched lazily on first request

		// 4. Register this instance for MCP discovery
		await registerInstance(port);

		// 5. Sync MCP server and configure Claude
		await syncMcpServer(context);
		await configureClaude();

		log.appendLine(`[Bridge] Started successfully on port ${port}`);
	} catch (err) {
		log.appendLine(`[Bridge] Failed to start: ${err}`);
		vscode.window.showErrorMessage(`Browser Bridge failed to start: ${err}`);
		await stopBridge();
	}
}

async function ensureBrowser(): Promise<void> {
	if (cdp?.state === 'connected' || browserLaunching) return;
	browserLaunching = true;
	try {
		await launchBrowser();
	} finally {
		browserLaunching = false;
	}
}

async function stopBridge(): Promise<void> {
	running = false;
	actualPort = null;
	cdp?.dispose();
	await httpServer?.stop();
	await unregisterInstance();
	statusBar?.update('disconnected', false);
	log?.appendLine('[Bridge] Stopped');
}

async function launchBrowser(): Promise<void> {
	const launched = await vscode.debug.startDebugging(undefined, {
		type: 'editor-browser',
		request: 'launch',
		name: 'Browser Bridge',
		url: 'about:blank',
		internalConsoleOptions: 'neverOpen',
	}, {
		noDebug: true,
		suppressDebugToolbar: true,
		suppressDebugView: true,
		suppressDebugStatusbar: true,
	} as vscode.DebugSessionOptions);
	if (!launched) {
		log.appendLine('[Bridge] Failed to launch editor-browser session');
		return;
	}
	await new Promise<void>((resolve) => {
		const sessions: vscode.DebugSession[] = [];
		const disposable = vscode.debug.onDidStartDebugSession(session => {
			if (isBrowserSession(session)) {
				sessions.push(session);
			}
		});
		setTimeout(async () => {
			disposable.dispose();
			if (sessions.length === 0) {
				log.appendLine('[Bridge] No browser sessions found');
				resolve();
				return;
			}
			const target = sessions[sessions.length - 1];
			try {
				await cdp.connectToSession(target);
			} catch (err) {
				log.appendLine(`[Bridge] CDP connect error: ${err}`);
			}
			resolve();
		}, 3000);
	});
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

		const existing = mcpServers[MCP_KEY] as { args?: string[]; env?: unknown } | undefined;
		if (existing?.args?.[0] === STABLE_SERVER && !existing.env) {
			log.appendLine('[MCP] Claude already configured');
			return;
		}

		mcpServers[MCP_KEY] = {
			command: 'node',
			args: [STABLE_SERVER],
		};
		config.mcpServers = mcpServers;

		await fs.promises.writeFile(claudeSettingsPath, JSON.stringify(config, null, 2) + '\n');
		log.appendLine(`[MCP] Configured Claude MCP in ${claudeSettingsPath}`);
	} catch (err) {
		log.appendLine(`[MCP] Failed to configure Claude: ${err}`);
	}
}

function showStatus(): void {
	const cdpState = cdp?.state ?? 'disconnected';
	const serverState = running ? 'running' : 'stopped';
	const port = actualPort ?? 'none';

	vscode.window.showInformationMessage(
		`Browser Bridge: CDP ${cdpState}, HTTP server ${serverState} on port ${port}`,
	);
}

export function deactivate() {
	return stopBridge();
}
