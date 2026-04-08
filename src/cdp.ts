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
	private reconnectAttempts = 0;
	private static readonly MAX_RECONNECT_ATTEMPTS = 5;
	private static readonly BASE_RECONNECT_DELAY = 1000;
	private _state: CDPState = 'disconnected';
	private _onStateChange = new vscode.EventEmitter<CDPState>();
	readonly onStateChange = this._onStateChange.event;

	private _sessionId: string | null = null;
	private _session: vscode.DebugSession | null = null;

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

	/** The debug session ID we're connected (or connecting) to. */
	get sessionId(): string | null {
		return this._sessionId;
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
		this.log.appendLine(`[CDP] connectToSession called (session: ${session.name}, id: ${session.id})`);
		this._session = session;
		this._sessionId = session.id;
		this.setState('connecting');

		try {
			const proxy = await this.requestCDPProxy(session);
			const wsUrl = `ws://${proxy.host}:${proxy.port}${proxy.path ?? ''}`;
			this.log.appendLine(`[CDP] Connecting WebSocket to ${wsUrl}`);
			await this.connectWebSocket(wsUrl);
		} catch (err) {
			this.log.appendLine(`[CDP] Failed to connect: ${err}`);
			this.setState('disconnected');
			this.scheduleReconnect();
		}
	}

	private async requestCDPProxy(
		session: vscode.DebugSession,
	): Promise<{ host: string; port: number; path?: string }> {
		// Must be called on a CHILD debug session (the page target), not the
		// root launcher session. The root session has no CDP connection.
		this.log.appendLine('[CDP] Requesting CDP proxy...');
		const proxy = await Promise.race([
			session.customRequest('requestCDPProxy'),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('requestCDPProxy timed out after 30s')), 30000),
			),
		]) as { host: string; port: number; path?: string };
		this.log.appendLine(`[CDP] Got proxy: ${JSON.stringify(proxy)}`);
		return proxy;
	}

	private connectWebSocket(url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			let settled = false;

			ws.on('open', async () => {
				this.ws = ws;
				this.reconnectAttempts = 0;
				this.setState('connected');
				this.log.appendLine('[CDP] WebSocket connected');
				settled = true;
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
					// Reconnect on unexpected mid-session drops
					if (settled) {
						this.scheduleReconnect();
					}
				}
			});

			ws.on('error', (err) => {
				this.log.appendLine(`[CDP] WebSocket error: ${err.message}`);
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
		});
	}

	private titleScriptId: string | null = null;

	private static readonly TITLE_SCRIPT = `
		(function() {
			var P = '\\u{1F534} ';
			var updating = false;

			function ensurePrefix() {
				if (updating) return;
				var el = document.querySelector('title');
				if (!el) return;
				if (!el.textContent.startsWith(P)) {
					updating = true;
					el.textContent = P + el.textContent;
					updating = false;
				}
			}

			// Watch for any title changes (HTML parsing, JS, SPA navigation)
			new MutationObserver(ensurePrefix).observe(document, {
				childList: true,
				subtree: true,
				characterData: true,
			});

			// Also intercept JS document.title setter
			var og = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
			if (og) {
				Object.defineProperty(document, 'title', {
					get: function() { return og.get.call(this); },
					set: function(v) {
						og.set.call(this, v.startsWith(P) ? v : P + v);
					},
					configurable: true,
				});
			}

			ensurePrefix();
		})();
	`;

	private async enableDomains(): Promise<void> {
		await Promise.all([
			this.send('Runtime.enable'),
			this.send('Page.enable'),
			this.send('Network.enable'),
			this.send('DOM.enable'),
			this.send('Accessibility.enable'),
		]);
		this.log.appendLine('[CDP] Domains enabled');
		await this.installTitlePrefix();
	}

	private async installTitlePrefix(): Promise<void> {
		try {
			// Inject on every future page load
			const result = await this.send('Page.addScriptToEvaluateOnNewDocument', {
				source: CDPConnection.TITLE_SCRIPT,
			}) as { identifier: string };
			this.titleScriptId = result.identifier;
			this.log.appendLine(`[CDP] Title prefix script installed (id: ${this.titleScriptId})`);

			// Also apply to the current page immediately
			await this.send('Runtime.evaluate', {
				expression: CDPConnection.TITLE_SCRIPT,
			});
			this.log.appendLine('[CDP] Title prefix applied to current page');
		} catch (err) {
			this.log.appendLine(`[CDP] Failed to install title prefix: ${err}`);
		}
	}

	private async removeTitlePrefix(): Promise<void> {
		try {
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				if (this.titleScriptId) {
					await this.send('Page.removeScriptToEvaluateOnNewDocument', {
						identifier: this.titleScriptId,
					}).catch(() => {});
					this.titleScriptId = null;
				}
				await this.send('Runtime.evaluate', {
					expression: `
						(function() {
							var P = '\\u{1F534} ';
							delete document.title;
							var og = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
							if (og && og.get.call(document).startsWith(P)) {
								og.set.call(document, og.get.call(document).slice(P.length));
							}
						})();
					`,
				}, 2000);
			}
		} catch {
			// Best-effort cleanup
		}
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

	send(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new Error('CDP not connected'));
				return;
			}
			const id = ++this.requestId;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP request timed out after ${timeoutMs}ms: ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => { clearTimeout(timer); resolve(v); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer || !this._session) return;
		if (this.reconnectAttempts >= CDPConnection.MAX_RECONNECT_ATTEMPTS) {
			this.log.appendLine(`[CDP] Max reconnect attempts (${CDPConnection.MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
			this._session = null;
			this._sessionId = null;
			return;
		}
		const delay = CDPConnection.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts);
		this.reconnectAttempts++;
		const session = this._session;
		this.log.appendLine(`[CDP] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${CDPConnection.MAX_RECONNECT_ATTEMPTS})`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.disposed && this._state === 'disconnected' && this._session === session) {
				this.connectToSession(session);
			}
		}, delay);
	}

	async disconnect(): Promise<void> {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this._session = null;
		this._sessionId = null;
		await this.removeTitlePrefix();
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
