import * as vscode from 'vscode';
import WebSocket from 'ws';

export type CDPState = 'disconnected' | 'connecting' | 'connected';

export interface ConsoleEntry {
	type: string;
	text: string;
	timestamp: number;
	/** Target type for entries originating in a child session (worker, iframe, service_worker). Absent for top-level page logs. */
	target?: string;
	/** Set by CDPManager when aggregating across tabs. */
	tabId?: string;
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
	/** Target type for entries originating in a child session (worker, iframe, service_worker). Absent for top-level requests. */
	target?: string;
	/** Set by CDPManager when aggregating across tabs. */
	tabId?: string;
}

interface ChildTargetInfo {
	type: string;
	url: string;
	targetId: string;
}

const CONSOLE_BUFFER_SIZE = 200;
const NETWORK_BUFFER_SIZE = 200;

/**
 * One browser tab's worth of CDP connection + buffers.
 *
 * Supports two transports, set by whichever `connectTo*` method is called:
 *  - `connectToSession(debugSession)` — uses `requestCDPProxy` → WebSocket (the debug-session fallback path; works on any VS Code 1.112+)
 *  - `connectToBrowserTab(tab)` — uses the proposed `browser` API's `BrowserTab.startCDPSession()` (requires `--enable-proposed-api`)
 */
export class CDPTab {
	readonly tabId: string;

	/** Display number assigned by the manager (1..N). Shown as prefix in the tab title. */
	displayNumber: number | null = null;

	private ws: WebSocket | null = null;
	private _browserTabSession: vscode.BrowserCDPSession | null = null;
	private _browserTab: vscode.BrowserTab | null = null;
	private browserTabDisposables: vscode.Disposable[] = [];
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
	private _transport: 'websocket' | 'browserTab' | null = null;

	/**
	 * CDP session ID for the primary page target. The browser CDP proxy
	 * requires explicit `Target.attachToTarget` before page-scoped commands
	 * and events work. All page-scoped `send()` calls are routed here unless
	 * an explicit `sessionId` override is passed.
	 */
	private _pageSessionId: string | null = null;

	/** CDP session ID for the browser-level handshake session. */
	private _browserSessionId: string | null = null;

	private consoleBuffer: ConsoleEntry[] = [];
	private networkBuffer: NetworkEntry[] = [];
	private networkMap = new Map<string, NetworkEntry>();
	private childSessions = new Map<string, ChildTargetInfo>();
	private eventCounts = new Map<string, number>();

	private log: vscode.OutputChannel;
	private disposed = false;

	constructor(tabId: string, log: vscode.OutputChannel) {
		this.tabId = tabId;
		this.log = log;
	}

	get state(): CDPState {
		return this._state;
	}

	/** The VS Code debug session this tab is bridged to, if on the websocket path. */
	get sessionId(): string | null {
		return this._sessionId;
	}

	/** The underlying BrowserTab, if on the proposed API path. */
	get browserTab(): vscode.BrowserTab | null {
		return this._browserTab;
	}

	/** Tab's current URL (from the BrowserTab proposal when available, else last known from navigation). */
	get url(): string {
		return this._browserTab?.url ?? this._lastKnownUrl ?? '';
	}

	/** Tab's current title (BrowserTab proposal only). */
	get title(): string {
		return this._browserTab?.title ?? this._lastKnownTitle ?? '';
	}

	private _lastKnownUrl = '';
	private _lastKnownTitle = '';

	/** Diagnostic: the CDP sessionId for the primary page target (or null). */
	get pageSessionId(): string | null {
		return this._pageSessionId;
	}

	/** Diagnostic: list of tracked child sessions (workers/iframes). */
	get children(): Array<{ sessionId: string; type: string; url: string }> {
		return Array.from(this.childSessions.entries()).map(([sessionId, info]) => ({
			sessionId,
			type: info.type,
			url: info.url,
		}));
	}

	/** Diagnostic: CDP event method → count. */
	get events(): Record<string, number> {
		return Object.fromEntries(this.eventCounts);
	}

	/** Diagnostic: which transport is active. */
	get transport(): 'websocket' | 'browserTab' | null {
		return this._transport;
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
		this.log.appendLine(`[CDP:${this.tabId}] connectToSession called (session: ${session.name}, id: ${session.id})`);
		this._session = session;
		this._sessionId = session.id;
		this._transport = 'websocket';
		this.setState('connecting');

		try {
			const proxy = await this.requestCDPProxy(session);
			const wsUrl = `ws://${proxy.host}:${proxy.port}${proxy.path ?? ''}`;
			this.log.appendLine(`[CDP:${this.tabId}] Connecting WebSocket to ${wsUrl}`);
			await this.connectWebSocket(wsUrl);
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] Failed to connect: ${err}`);
			this.setState('disconnected');
			this.scheduleReconnect();
		}
	}

	/**
	 * Connect via VS Code's proposed `browser` API (BrowserTab.startCDPSession).
	 * This bypasses vscode-js-debug entirely, giving us direct access to the
	 * multiplexed CDP stream. Events from all sessions (worker, iframe,
	 * service_worker) flow without js-debug's sessionId-stripping subscribe
	 * filter. Requires `--enable-proposed-api=thimo.integrated-browser-mcp`
	 * when launching VS Code.
	 */
	async connectToBrowserTab(tab: vscode.BrowserTab): Promise<void> {
		this.log.appendLine(`[CDP:${this.tabId}] connectToBrowserTab called (url: ${tab.url})`);
		this._browserTab = tab;
		this._transport = 'browserTab';
		this.setState('connecting');

		try {
			const session = await tab.startCDPSession();
			this._browserTabSession = session;
			this.browserTabDisposables.push(
				session.onDidReceiveMessage((msg: unknown) => {
					this.handleMessage(msg as Record<string, unknown>);
				}),
				session.onDidClose(() => {
					this.log.appendLine(`[CDP:${this.tabId}] BrowserCDPSession closed`);
					this._browserTabSession = null;
					this.pending.forEach(p => p.reject(new Error('Session closed')));
					this.pending.clear();
					if (!this.disposed) this.setState('disconnected');
				}),
			);
			this.setState('connected');
			this.log.appendLine(`[CDP:${this.tabId}] BrowserCDPSession ready`);
			await this.establishPageSession();
			await this.enableDomains();
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] connectToBrowserTab failed: ${err}`);
			this.setState('disconnected');
		}
	}

	private async requestCDPProxy(
		session: vscode.DebugSession,
	): Promise<{ host: string; port: number; path?: string }> {
		// Must be called on a CHILD debug session (the page target), not the
		// root launcher session. The root session has no CDP connection.
		this.log.appendLine(`[CDP:${this.tabId}] Requesting CDP proxy...`);
		const proxy = await Promise.race([
			session.customRequest('requestCDPProxy'),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('requestCDPProxy timed out after 30s')), 30000),
			),
		]) as { host: string; port: number; path?: string };
		this.log.appendLine(`[CDP:${this.tabId}] Got proxy: ${JSON.stringify(proxy)}`);
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
				this.log.appendLine(`[CDP:${this.tabId}] WebSocket connected`);
				settled = true;
				try {
					await this.subscribeToEvents();
					await this.establishPageSession();
					await this.enableDomains();
				} catch (err) {
					this.log.appendLine(`[CDP:${this.tabId}] Failed to enable domains: ${err}`);
				}
				resolve();
			});

			ws.on('message', (data) => {
				try {
					const msg = JSON.parse(data.toString());
					this.handleMessage(msg);
				} catch (err) {
					this.log.appendLine(`[CDP:${this.tabId}] Message parse error: ${err}`);
				}
			});

			ws.on('close', () => {
				this.log.appendLine(`[CDP:${this.tabId}] WebSocket closed`);
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
				this.log.appendLine(`[CDP:${this.tabId}] WebSocket error: ${err.message}`);
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
		});
	}

	private handleMessage(msg: Record<string, unknown>): void {
		if (msg.id !== undefined) {
			const p = this.pending.get(msg.id as number);
			if (p) {
				this.pending.delete(msg.id as number);
				if (msg.error) {
					p.reject(new Error((msg.error as { message: string }).message));
				} else {
					p.resolve(msg.result);
				}
			}
		} else if (msg.method) {
			this.handleEvent(
				msg.method as string,
				(msg.params ?? {}) as Record<string, unknown>,
				msg.sessionId as string | undefined,
			);
		}
	}

	private titleScriptId: string | null = null;
	private currentTitlePrefix: string | null = null;

	/**
	 * Build the title-prefix script for a given prefix. Strips any previously-
	 * set prefix (either our own numbered-circles / fisheye / overflow emoji,
	 * or a stale one from an earlier install) and prepends the current one.
	 *
	 * The script is idempotent on re-install: subsequent runs disconnect the
	 * previous MutationObserver before installing a new one, and share the
	 * document.title setter interception via a one-time flag.
	 */
	private buildTitleScript(prefix: string): string {
		const prefixJson = JSON.stringify(prefix);
		// Any of our known markers that a previous install (or a stale script
		// left behind by an earlier extension version) may have stacked onto
		// the title. The `+` makes this greedy: `◉ ① ② Site` strips back to
		// `Site` in one shot, preventing oscillation with a rival script that
		// keeps prepending its own marker. Keep the character set in sync with
		// `numberToPrefix`.
		const STRIP_RE = '/^(?:(?:[\\u{2460}-\\u{2473}\\u{25C9}]|\\u{1F92F}) )+/u';
		return `(function(){
			var P = ${prefixJson};
			var STRIP = ${STRIP_RE};
			var updating = false;

			function ensurePrefix() {
				if (updating) return;
				var el = document.querySelector('title');
				if (!el) {
					// Create a <title> so pages without one (about:blank, some
					// API responses) still show the tab number prefix.
					var host = document.head || document.documentElement;
					if (!host) return;
					el = document.createElement('title');
					updating = true;
					host.appendChild(el);
					updating = false;
				}
				var stripped = el.textContent.replace(STRIP, '');
				var want = P + stripped;
				if (el.textContent !== want) {
					updating = true;
					el.textContent = want;
					updating = false;
				}
			}

			// Replace any previous observer installed by a prior prefix update.
			if (window.__bridgeTitleObserver) {
				try { window.__bridgeTitleObserver.disconnect(); } catch (_) {}
			}
			var observer = new MutationObserver(ensurePrefix);
			observer.observe(document, { childList: true, subtree: true, characterData: true });
			window.__bridgeTitleObserver = observer;

			// Intercept JS document.title setter once. Subsequent installs just
			// update the active prefix via the shared getter/setter.
			window.__bridgeTabPrefix = P;
			if (!window.__bridgeTitleIntercepted) {
				var og = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
				if (og) {
					Object.defineProperty(document, 'title', {
						get: function() { return og.get.call(this); },
						set: function(v) {
							var current = window.__bridgeTabPrefix || '';
							var s = String(v).replace(STRIP, '');
							og.set.call(this, current + s);
						},
						configurable: true,
					});
					window.__bridgeTitleIntercepted = true;
				}
			}

			ensurePrefix();
		})();`;
	}

	/**
	 * vscode-js-debug's CDP proxy only forwards events the client has
	 * subscribed to (via the synthetic `JsDebug.subscribe` domain). Without
	 * this, no Runtime/Network/Target events reach our WebSocket — only
	 * command responses. Supports `Domain.*` wildcards.
	 * @see vscode-js-debug/src/adapter/cdpProxy.ts
	 */
	private async subscribeToEvents(): Promise<void> {
		try {
			await this.send('JsDebug.subscribe', {
				events: ['Runtime.*', 'Network.*', 'Target.*', 'Page.*'],
			}, { sessionId: null });
			this.log.appendLine(`[CDP:${this.tabId}] Subscribed to events (Runtime, Network, Target, Page)`);
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] JsDebug.subscribe failed (${err}); events may not flow`);
		}
	}

	/**
	 * In VS Code 1.117+, the browser CDP proxy requires an explicit attach
	 * to the browser target before Target queries return page targets, and
	 * page-scoped commands/events must carry the page session id. On older
	 * versions the proxy auto-routed commands, so we gracefully fall back to
	 * implicit routing if the handshake isn't supported.
	 */
	private async establishPageSession(): Promise<void> {
		let browserSessionId: string | undefined;
		try {
			const r = await this.send('Target.attachToBrowserTarget', undefined, {
				sessionId: null,
			}) as { sessionId?: string };
			browserSessionId = r.sessionId;
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] attachToBrowserTarget failed (${err}); falling back to implicit routing`);
			return;
		}
		if (!browserSessionId) {
			this.log.appendLine(`[CDP:${this.tabId}] attachToBrowserTarget returned no sessionId`);
			return;
		}
		this._browserSessionId = browserSessionId;
		// Scrub the browser session from childSessions in case its attachedToTarget
		// event raced ahead of this assignment.
		this.childSessions.delete(browserSessionId);

		try {
			const targetsResult = await this.send('Target.getTargets', undefined, {
				sessionId: browserSessionId,
			}) as { targetInfos?: Array<{ targetId: string; type: string; url?: string }> };
			const pages = (targetsResult.targetInfos ?? []).filter(t => t.type === 'page');
			if (pages.length === 0) {
				this.log.appendLine(`[CDP:${this.tabId}] No page target found`);
				return;
			}
			// On the proposed API path, each BrowserCDPSession wraps ONE tab, so
			// the first page is this tab's page. On the websocket path (per-debug-
			// session), same story. Picking pages[0] is therefore always correct.
			const page = pages[0];
			const attachResult = await this.send('Target.attachToTarget', {
				targetId: page.targetId,
				flatten: true,
			}, { sessionId: browserSessionId }) as { sessionId?: string };
			if (attachResult.sessionId) {
				this._pageSessionId = attachResult.sessionId;
				this._lastKnownUrl = page.url ?? '';
				// Same racing concern as the browser session above.
				this.childSessions.delete(attachResult.sessionId);
				this.log.appendLine(`[CDP:${this.tabId}] Attached to page session ${attachResult.sessionId} (${page.url ?? page.targetId})`);
			} else {
				this.log.appendLine(`[CDP:${this.tabId}] Target.attachToTarget returned no sessionId`);
			}
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] Page session bootstrap failed (${err})`);
		}
	}

	private async enableDomains(): Promise<void> {
		await Promise.all([
			this.send('Runtime.enable'),
			this.send('Page.enable'),
			this.send('Network.enable'),
			this.send('DOM.enable'),
			this.send('Accessibility.enable'),
		]);
		this.log.appendLine(`[CDP:${this.tabId}] Domains enabled`);
		await this.enableAutoAttach();
		// Title prefix is installed separately by CDPManager once the tab's
		// display number is known.
	}

	/**
	 * Enable the browser CDP proxy's auto-attach so worker/iframe targets
	 * registered by VS Code's browserViewGroup are attached automatically.
	 * Sent at browser/root level (sessionId: null) — that sets the proxy's
	 * internal `_autoAttach` flag. Per-session setAutoAttach wouldn't help
	 * because child sessions created via CDP auto-attach bypass the proxy's
	 * session map.
	 */
	private async enableAutoAttach(): Promise<void> {
		try {
			await this.send('Target.setAutoAttach', {
				autoAttach: true,
				waitForDebuggerOnStart: false,
				flatten: true,
			}, { sessionId: null });
			this.log.appendLine(`[CDP:${this.tabId}] Auto-attach enabled`);
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] setAutoAttach not supported (${err}); child sessions will not be captured`);
		}
	}

	/**
	 * Install or update the tab-title prefix (e.g. "① "). Called by CDPManager
	 * on adopt and on renumber. Idempotent: skips CDP work if the prefix is
	 * already the requested one.
	 */
	async setTitlePrefix(prefix: string): Promise<void> {
		if (this.currentTitlePrefix === prefix) return;
		this.currentTitlePrefix = prefix;
		const hasTransport = (this.ws && this.ws.readyState === WebSocket.OPEN) || this._browserTabSession !== null;
		if (!hasTransport) return;
		const script = this.buildTitleScript(prefix);
		try {
			// Remove prior on-new-document script (if any) before adding the new one.
			if (this.titleScriptId) {
				await this.send('Page.removeScriptToEvaluateOnNewDocument', {
					identifier: this.titleScriptId,
				}).catch(() => {});
				this.titleScriptId = null;
			}
			const result = await this.send('Page.addScriptToEvaluateOnNewDocument', {
				source: script,
			}) as { identifier: string };
			this.titleScriptId = result.identifier;
			// Apply to the current document.
			await this.send('Runtime.evaluate', { expression: script });
			this.log.appendLine(`[CDP:${this.tabId}] Title prefix set to "${prefix}"`);
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] Failed to set title prefix: ${err}`);
		}
	}

	private async removeTitlePrefix(): Promise<void> {
		try {
			const hasTransport = (this.ws && this.ws.readyState === WebSocket.OPEN) || this._browserTabSession !== null;
			if (!hasTransport) return;
			if (this.titleScriptId) {
				await this.send('Page.removeScriptToEvaluateOnNewDocument', {
					identifier: this.titleScriptId,
				}).catch(() => {});
				this.titleScriptId = null;
			}
			// Best-effort: disconnect observer + strip any of our prefix markers.
			await this.send('Runtime.evaluate', {
				expression: `(function(){
					try { if (window.__bridgeTitleObserver) window.__bridgeTitleObserver.disconnect(); } catch (_) {}
					window.__bridgeTabPrefix = '';
					var el = document.querySelector('title');
					if (el) {
						el.textContent = el.textContent.replace(/^(?:[\\u{2460}-\\u{2473}\\u{25C9}]|\\u{1F92F}) /u, '');
					}
				})();`,
			}, { timeoutMs: 2000 });
		} catch {
			// Best-effort cleanup
		}
	}

	private handleEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
		this.eventCounts.set(method, (this.eventCounts.get(method) ?? 0) + 1);
		switch (method) {
			case 'Runtime.consoleAPICalled':
				this.onConsole(params, sessionId);
				break;
			case 'Network.requestWillBeSent':
				this.onNetworkRequest(params, sessionId);
				break;
			case 'Network.responseReceived':
				this.onNetworkResponse(params);
				break;
			case 'Target.attachedToTarget':
				this.onTargetAttached(params);
				break;
			case 'Target.detachedFromTarget':
				this.onTargetDetached(params);
				break;
			case 'Page.frameNavigated': {
				const frame = params.frame as { url?: string; parentId?: string } | undefined;
				// Root frame only — subframes don't set our tab's URL.
				if (frame?.url && !frame.parentId) this._lastKnownUrl = frame.url;
				break;
			}
		}
	}

	private onTargetAttached(params: Record<string, unknown>): void {
		const sessionId = params.sessionId as string | undefined;
		const targetInfo = params.targetInfo as { type: string; url: string; targetId: string } | undefined;
		if (!sessionId || !targetInfo) return;
		// Skip our own handshake sessions — they aren't children to tag.
		if (sessionId === this._pageSessionId || sessionId === this._browserSessionId) return;
		this.childSessions.set(sessionId, {
			type: targetInfo.type,
			url: targetInfo.url,
			targetId: targetInfo.targetId,
		});
		this.log.appendLine(`[CDP:${this.tabId}] Child session attached: ${targetInfo.type} (${targetInfo.url || targetInfo.targetId})`);
		// Enable Runtime + Network on the child so its events flow through.
		// Browser-level targets can't enable Network; skip those.
		this.send('Runtime.enable', undefined, { sessionId }).catch(err => {
			this.log.appendLine(`[CDP:${this.tabId}] Runtime.enable failed for ${targetInfo.type}: ${err}`);
		});
		if (targetInfo.type !== 'browser') {
			this.send('Network.enable', undefined, { sessionId }).catch(err => {
				this.log.appendLine(`[CDP:${this.tabId}] Network.enable failed for ${targetInfo.type}: ${err}`);
			});
		}
	}

	private onTargetDetached(params: Record<string, unknown>): void {
		const sessionId = params.sessionId as string | undefined;
		if (!sessionId) return;
		const info = this.childSessions.get(sessionId);
		if (info) {
			this.log.appendLine(`[CDP:${this.tabId}] Child session detached: ${info.type}`);
			this.childSessions.delete(sessionId);
		}
	}

	private onConsole(params: Record<string, unknown>, sessionId?: string): void {
		const args = params.args as Array<{ type: string; value?: unknown; description?: string }> | undefined;
		const text = args
			? args.map(a => a.value !== undefined ? String(a.value) : a.description ?? '').join(' ')
			: '';
		const entry: ConsoleEntry = {
			type: params.type as string,
			text,
			timestamp: Date.now(),
		};
		const target = sessionId ? this.childSessions.get(sessionId)?.type : undefined;
		if (target) entry.target = target;
		this.consoleBuffer.push(entry);
		if (this.consoleBuffer.length > CONSOLE_BUFFER_SIZE) {
			this.consoleBuffer.shift();
		}
	}

	private onNetworkRequest(params: Record<string, unknown>, sessionId?: string): void {
		const request = params.request as { method: string; url: string } | undefined;
		if (!request) return;
		const entry: NetworkEntry = {
			requestId: params.requestId as string,
			method: request.method,
			url: request.url,
			type: params.type as string | undefined,
			timestamp: Date.now(),
		};
		const target = sessionId ? this.childSessions.get(sessionId)?.type : undefined;
		if (target) entry.target = target;
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

	/**
	 * Send a CDP command. By default routes to the primary page session
	 * (`_pageSessionId`). Pass `opts.sessionId` as:
	 *   - a string: explicit session id (e.g. a worker/iframe child).
	 *   - `null`: no sessionId in envelope; the proxy handles it at browser/root level
	 *     (needed for Browser.* / Target.* commands during session bootstrap).
	 *   - omitted / undefined: fall through to `_pageSessionId` if known.
	 */
	send(
		method: string,
		params?: Record<string, unknown>,
		opts: { sessionId?: string | null; timeoutMs?: number } = {},
	): Promise<unknown> {
		const timeoutMs = opts.timeoutMs ?? 30000;
		return new Promise((resolve, reject) => {
			const wsOpen = this.ws && this.ws.readyState === WebSocket.OPEN;
			const tabOpen = this._browserTabSession !== null;
			if (!wsOpen && !tabOpen) {
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
			const envelope: Record<string, unknown> = { id, method, params };
			const sessionId = opts.sessionId === undefined ? this._pageSessionId : opts.sessionId;
			if (sessionId) envelope.sessionId = sessionId;
			if (this._browserTabSession) {
				this._browserTabSession.sendMessage(envelope).then(undefined, (err: Error) => {
					this.pending.delete(id);
					clearTimeout(timer);
					reject(err);
				});
			} else {
				this.ws!.send(JSON.stringify(envelope));
			}
		});
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer || !this._session) return;
		if (this.reconnectAttempts >= CDPTab.MAX_RECONNECT_ATTEMPTS) {
			this.log.appendLine(`[CDP:${this.tabId}] Max reconnect attempts (${CDPTab.MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
			this._session = null;
			this._sessionId = null;
			return;
		}
		const delay = CDPTab.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts);
		this.reconnectAttempts++;
		const session = this._session;
		this.log.appendLine(`[CDP:${this.tabId}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${CDPTab.MAX_RECONNECT_ATTEMPTS})`);
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
		this._pageSessionId = null;
		this._browserSessionId = null;
		this._transport = null;
		await this.removeTitlePrefix();
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.browserTabDisposables.forEach(d => d.dispose());
		this.browserTabDisposables = [];
		if (this._browserTabSession) {
			try { await this._browserTabSession.close(); } catch { /* best effort */ }
			this._browserTabSession = null;
		}
		this._browserTab = null;
		this.pending.forEach(p => p.reject(new Error('Disconnected')));
		this.pending.clear();
		this.childSessions.clear();
		this.setState('disconnected');
	}

	dispose(): void {
		this.disposed = true;
		this.disconnect();
		this._onStateChange.dispose();
	}
}
