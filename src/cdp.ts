import * as vscode from 'vscode';
import WebSocket from 'ws';

export type CDPState = 'disconnected' | 'connecting' | 'connected';

export interface ConsoleEntry {
	type: string;
	text: string;
	timestamp: number;
}

export interface NetworkEntry {
	requestId: string;
	method: string;
	url: string;
	status?: number;
	statusText?: string;
	type?: string;
	timestamp: number;
	responseTimestamp?: number;
}

const CONSOLE_BUFFER_SIZE = 200;
const NETWORK_BUFFER_SIZE = 200;

export class CDPConnection {
	private ws: WebSocket | null = null;
	private requestId = 0;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _state: CDPState = 'disconnected';
	private _onStateChange = new vscode.EventEmitter<CDPState>();
	readonly onStateChange = this._onStateChange.event;

	private consoleBuffer: ConsoleEntry[] = [];
	private networkBuffer: NetworkEntry[] = [];
	private networkMap = new Map<string, NetworkEntry>();

	private log: vscode.OutputChannel;
	private disposed = false;

	constructor(log: vscode.OutputChannel) {
		this.log = log;
	}

	get state(): CDPState {
		return this._state;
	}

	get console(): ConsoleEntry[] {
		return this.consoleBuffer;
	}

	get network(): NetworkEntry[] {
		return this.networkBuffer;
	}

	clearNetwork(): void {
		this.networkBuffer = [];
		this.networkMap.clear();
	}

	private setState(state: CDPState): void {
		this._state = state;
		this._onStateChange.fire(state);
	}

	async connectToSession(session: vscode.DebugSession): Promise<void> {
		this.setState('connecting');
		try {
			const proxy = await session.customRequest('requestCDPProxy') as { host: string; port: number; path?: string };
			const wsUrl = `ws://${proxy.host}:${proxy.port}${proxy.path ?? ''}`;
			this.log.appendLine(`[CDP] Connecting to ${wsUrl}`);
			await this.connectWebSocket(wsUrl);
		} catch (err) {
			this.log.appendLine(`[CDP] Failed to get CDP proxy: ${err}`);
			this.setState('disconnected');
			this.scheduleReconnect(session);
		}
	}

	private connectWebSocket(url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);

			ws.on('open', async () => {
				this.ws = ws;
				this.setState('connected');
				this.log.appendLine('[CDP] WebSocket connected');
				try {
					await this.enableDomains();
				} catch (err) {
					this.log.appendLine(`[CDP] Failed to enable domains: ${err}`);
				}
				resolve();
			});

			ws.on('message', (data) => {
				try {
					const msg = JSON.parse(data.toString());
					if (msg.id !== undefined) {
						const p = this.pending.get(msg.id);
						if (p) {
							this.pending.delete(msg.id);
							if (msg.error) {
								p.reject(new Error(msg.error.message));
							} else {
								p.resolve(msg.result);
							}
						}
					} else if (msg.method) {
						this.handleEvent(msg.method, msg.params);
					}
				} catch (err) {
					this.log.appendLine(`[CDP] Message parse error: ${err}`);
				}
			});

			ws.on('close', () => {
				this.log.appendLine('[CDP] WebSocket closed');
				this.ws = null;
				this.pending.forEach(p => p.reject(new Error('WebSocket closed')));
				this.pending.clear();
				if (!this.disposed) {
					this.setState('disconnected');
				}
			});

			ws.on('error', (err) => {
				this.log.appendLine(`[CDP] WebSocket error: ${err.message}`);
				reject(err);
			});
		});
	}

	private async enableDomains(): Promise<void> {
		await Promise.all([
			this.send('Runtime.enable'),
			this.send('Page.enable'),
			this.send('Network.enable'),
			this.send('DOM.enable'),
		]);
	}

	private handleEvent(method: string, params: Record<string, unknown>): void {
		switch (method) {
			case 'Runtime.consoleAPICalled':
				this.onConsole(params);
				break;
			case 'Network.requestWillBeSent':
				this.onNetworkRequest(params);
				break;
			case 'Network.responseReceived':
				this.onNetworkResponse(params);
				break;
		}
	}

	private onConsole(params: Record<string, unknown>): void {
		const args = params.args as Array<{ type: string; value?: unknown; description?: string }> | undefined;
		const text = args
			? args.map(a => a.value !== undefined ? String(a.value) : a.description ?? '').join(' ')
			: '';
		const entry: ConsoleEntry = {
			type: params.type as string,
			text,
			timestamp: Date.now(),
		};
		this.consoleBuffer.push(entry);
		if (this.consoleBuffer.length > CONSOLE_BUFFER_SIZE) {
			this.consoleBuffer.shift();
		}
	}

	private onNetworkRequest(params: Record<string, unknown>): void {
		const request = params.request as { method: string; url: string } | undefined;
		if (!request) return;
		const entry: NetworkEntry = {
			requestId: params.requestId as string,
			method: request.method,
			url: request.url,
			type: params.type as string | undefined,
			timestamp: Date.now(),
		};
		this.networkMap.set(entry.requestId, entry);
		this.networkBuffer.push(entry);
		if (this.networkBuffer.length > NETWORK_BUFFER_SIZE) {
			const removed = this.networkBuffer.shift()!;
			this.networkMap.delete(removed.requestId);
		}
	}

	private onNetworkResponse(params: Record<string, unknown>): void {
		const entry = this.networkMap.get(params.requestId as string);
		if (!entry) return;
		const response = params.response as { status: number; statusText: string } | undefined;
		if (response) {
			entry.status = response.status;
			entry.statusText = response.statusText;
			entry.responseTimestamp = Date.now();
		}
	}

	send(method: string, params?: Record<string, unknown>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new Error('CDP not connected'));
				return;
			}
			const id = ++this.requestId;
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	private scheduleReconnect(session: vscode.DebugSession): void {
		if (this.disposed || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.disposed && this._state === 'disconnected') {
				this.connectToSession(session);
			}
		}, 3000);
	}

	disconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.pending.forEach(p => p.reject(new Error('Disconnected')));
		this.pending.clear();
		this.setState('disconnected');
	}

	dispose(): void {
		this.disposed = true;
		this.disconnect();
		this._onStateChange.dispose();
	}
}
