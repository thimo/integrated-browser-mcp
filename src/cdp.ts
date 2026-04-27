import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CDPTab, CDPState, ConsoleEntry, NetworkEntry, DownloadEntry } from './cdp-tab';

export { CDPState, ConsoleEntry, NetworkEntry, DownloadEntry };

export interface TabInfo {
	tabId: string;
	/** 1-indexed display number matching the `①②③…` prefix in the tab title. Over 20 → null (tab shows `🤯`). */
	number: number | null;
	url: string;
	title: string;
	active: boolean;
	state: CDPState;
	transport: 'websocket' | 'browserTab' | null;
}

function generateTabId(): string {
	return 'tab-' + crypto.randomBytes(4).toString('hex');
}

/**
 * `(N) ` parenthesised decimal prefix. ASCII, high contrast, legible at any
 * tab width, no upper cap. Matches the status bar's `Browser MCP (N)` count
 * notation. Replaces earlier Unicode circled-digit approaches (outlined
 * ①..⑳, negative ❶..⓴) which rendered too small in VS Code's tab strip.
 */
function numberToPrefix(n: number): string {
	return `(${n}) `;
}

/**
 * Owns a collection of {@link CDPTab}s and routes requests to the active or
 * explicitly-specified tab.
 *
 * Multi-tab is only meaningful on the proposed `browser` API path
 * (`openBrowserTab` + `BrowserTab.startCDPSession`). On the websocket /
 * debug-session fallback path, the manager wraps a single synthetic
 * `tab-main` and refuses multi-tab operations with a clear error.
 */
export class CDPManager {
	private tabs = new Map<string, CDPTab>();
	private _activeTabId: string | null = null;
	private tabSubscriptions = new Map<string, vscode.Disposable>();
	private log: vscode.OutputChannel;
	private _onStateChange = new vscode.EventEmitter<CDPState>();
	readonly onStateChange = this._onStateChange.event;

	/**
	 * Unique-per-process id used to mark BrowserTabs we own. VS Code's
	 * proposed `browser` API exposes tabs to every extension host that has
	 * the proposal enabled — across all windows. Without a cooperation
	 * marker, two bridge instances (e.g. two VS Code windows with this
	 * extension) would both adopt the same BrowserTab, install competing
	 * title scripts, and cause title oscillation + eventual page crash.
	 */
	readonly ownerId = 'owner-' + crypto.randomBytes(6).toString('hex');

	/** Pick the lowest unused display number so new tabs reclaim gaps left by closed tabs. */
	private allocateNumber(): number {
		const used = new Set<number>();
		for (const tab of this.tabs.values()) {
			if (tab.displayNumber !== null) used.add(tab.displayNumber);
		}
		let n = 1;
		while (used.has(n)) n++;
		return n;
	}

	/**
	 * Dedupe concurrent `adoptBrowserTab` calls for the same underlying
	 * {@link vscode.BrowserTab}. `openTab` calls `adoptBrowserTab`, and the
	 * `onDidOpenBrowserTab` listener also does — without this cache they race,
	 * and a caller can get back a CDPTab whose connect is still in flight,
	 * causing `send()` to fail with "CDP not connected".
	 */
	private pendingAdoptions = new Map<vscode.BrowserTab, Promise<CDPTab>>();

	constructor(log: vscode.OutputChannel) {
		this.log = log;
	}

	/** Aggregate state: `connected` if any tab is; `connecting` if any is; else `disconnected`. */
	get state(): CDPState {
		if (this.tabs.size === 0) return 'disconnected';
		let sawConnecting = false;
		for (const tab of this.tabs.values()) {
			if (tab.state === 'connected') return 'connected';
			if (tab.state === 'connecting') sawConnecting = true;
		}
		return sawConnecting ? 'connecting' : 'disconnected';
	}

	/** Which transport all tabs are using (they all share one mode per session). */
	get transport(): 'websocket' | 'browserTab' | null {
		for (const tab of this.tabs.values()) {
			if (tab.transport) return tab.transport;
		}
		return null;
	}

	get activeTabId(): string | null {
		return this._activeTabId;
	}

	get tabCount(): number {
		return this.tabs.size;
	}

	/**
	 * Resolve a tab. When `tabId` is omitted, returns the active tab, or the
	 * only tab if there's exactly one, or `undefined`.
	 */
	getTab(tabId?: string): CDPTab | undefined {
		if (tabId) return this.tabs.get(tabId);
		if (this._activeTabId) return this.tabs.get(this._activeTabId);
		if (this.tabs.size === 1) return this.tabs.values().next().value;
		return undefined;
	}

	list(): TabInfo[] {
		return Array.from(this.tabs.values()).map(tab => ({
			tabId: tab.tabId,
			number: tab.displayNumber,
			url: tab.url,
			title: tab.title,
			active: tab.tabId === this._activeTabId,
			state: tab.state,
			transport: tab.transport,
		}));
	}

	/**
	 * Open a new browser tab via the proposed API. Requires VS Code to be
	 * launched with `--enable-proposed-api=thimo.integrated-browser-mcp`.
	 *
	 * Opens the tab at `about:blank` first and navigates afterward. That order
	 * matters: the CDP handshake + proxy-level `Target.setAutoAttach` need to
	 * complete before the destination page loads, otherwise a web worker
	 * spawned on initial load can race our auto-attach and never get captured.
	 */
	async openTab(url: string, makeActive = true): Promise<CDPTab> {
		if (typeof vscode.window.openBrowserTab !== 'function') {
			throw new Error(
				'Multi-tab requires VS Code to be launched with --enable-proposed-api=thimo.integrated-browser-mcp. See README.',
			);
		}
		const browserTab = await vscode.window.openBrowserTab('about:blank', { preserveFocus: !makeActive });
		const tab = await this.adoptBrowserTab(browserTab, makeActive);
		if (url !== 'about:blank') {
			await tab.send('Page.navigate', { url });
		}
		return tab;
	}

	/**
	 * Wrap an existing {@link vscode.BrowserTab} in a {@link CDPTab} and start
	 * its CDP session. Idempotent: returns the existing wrapper if already
	 * tracked. Called both for tabs we created via {@link openTab} and for
	 * tabs the user opened via VS Code UI (via `onDidOpenBrowserTab`).
	 */
	async adoptBrowserTab(browserTab: vscode.BrowserTab, makeActive = false): Promise<CDPTab> {
		// An in-flight adoption takes priority: a concurrent caller must wait
		// for the connect + title-prefix to finish, not grab the half-built
		// tab reference from the map.
		const pending = this.pendingAdoptions.get(browserTab);
		if (pending) return pending;
		for (const tab of this.tabs.values()) {
			if (tab.browserTab === browserTab) return tab;
		}
		const promise = (async () => {
			const tab = new CDPTab(generateTabId(), this.log);
			tab.displayNumber = this.allocateNumber();
			this.registerTab(tab);
			await tab.connectToBrowserTab(browserTab);

			// No bridge-level ownership handshake: the proposed API is
			// per-window, so two bridges never see the same tab. The check
			// we used to have here blocked legitimate reclaim after a window
			// reload (previous instance leaves a stale `window.__bridgeOwner`
			// in the page JS; a fresh instance must be allowed to take over).
			// The title-script's own loop-detection backs off cleanly if it
			// does somehow end up fighting a stale observer.

			if (tab.displayNumber !== null) {
				await tab.setTitlePrefix(numberToPrefix(tab.displayNumber), this.ownerId);
			}
			if (makeActive || this.tabs.size === 1) this._activeTabId = tab.tabId;
			this.emitStateChange();
			return tab;
		})();
		this.pendingAdoptions.set(browserTab, promise);
		promise.finally(() => this.pendingAdoptions.delete(browserTab));
		return promise;
	}

	/**
	 * Adopt a VS Code debug session (fallback path). Creates a single synthetic
	 * tab with id `tab-main`.
	 */
	async adoptDebugSession(session: vscode.DebugSession): Promise<CDPTab> {
		const existing = this.tabs.get('tab-main');
		if (existing) return existing;
		const tab = new CDPTab('tab-main', this.log);
		tab.displayNumber = 1;
		this.registerTab(tab);
		await tab.connectToSession(session);
		await tab.setTitlePrefix(numberToPrefix(1));
		this._activeTabId = 'tab-main';
		this.emitStateChange();
		return tab;
	}

	private registerTab(tab: CDPTab): void {
		this.tabs.set(tab.tabId, tab);
		this.tabSubscriptions.set(tab.tabId, tab.onStateChange(() => this.emitStateChange()));
	}

	private emitStateChange(): void {
		// Always fire — status-bar rendering depends on both state AND tab
		// count; tab count can change without state changing (e.g. dropping
		// a never-connected tab after an ownership conflict), and the bar
		// needs to re-render to switch out of warning.
		this._onStateChange.fire(this.state);
	}

	async closeTab(tabId: string): Promise<void> {
		const tab = this.tabs.get(tabId);
		if (!tab) throw new Error(`No tab: ${tabId}`);
		// If it's a BrowserTab, close the VS Code tab too; lifecycle event will
		// trigger untrack via onDidCloseBrowserTab. For the fallback path,
		// just disconnect.
		const underlying = tab.browserTab;
		await tab.disconnect();
		tab.dispose();
		this.tabSubscriptions.get(tabId)?.dispose();
		this.tabSubscriptions.delete(tabId);
		this.tabs.delete(tabId);
		if (this._activeTabId === tabId) {
			this._activeTabId = this.tabs.size > 0 ? this.tabs.keys().next().value ?? null : null;
		}
		if (underlying) {
			try { await underlying.close(); } catch { /* already closed */ }
		}
		this.emitStateChange();
	}

	/** Called when the user closes a browser tab via the VS Code UI. */
	untrackBrowserTab(browserTab: vscode.BrowserTab): void {
		for (const tab of this.tabs.values()) {
			if (tab.browserTab === browserTab) {
				tab.dispose();
				this.tabSubscriptions.get(tab.tabId)?.dispose();
				this.tabSubscriptions.delete(tab.tabId);
				this.tabs.delete(tab.tabId);
				if (this._activeTabId === tab.tabId) {
					this._activeTabId = this.tabs.size > 0 ? this.tabs.keys().next().value ?? null : null;
				}
				this.emitStateChange();
				return;
			}
		}
	}

	/** Sync internal active tab with `vscode.window.activeBrowserTab` events. */
	syncActive(browserTab: vscode.BrowserTab | undefined): void {
		if (!browserTab) return; // keep whatever we had
		for (const tab of this.tabs.values()) {
			if (tab.browserTab === browserTab) {
				this._activeTabId = tab.tabId;
				return;
			}
		}
	}

	activate(tabId: string): void {
		if (!this.tabs.has(tabId)) throw new Error(`No tab: ${tabId}`);
		this._activeTabId = tabId;
	}

	/** Aggregated across all tabs, stamped with originating tabId. */
	get console(): ConsoleEntry[] {
		const all: ConsoleEntry[] = [];
		for (const tab of this.tabs.values()) {
			for (const e of tab.console) all.push({ ...e, tabId: tab.tabId });
		}
		return all.sort((a, b) => a.timestamp - b.timestamp);
	}

	/** Per-tab console buffer (empty array if tab doesn't exist). */
	consoleForTab(tabId: string): ConsoleEntry[] {
		const tab = this.tabs.get(tabId);
		if (!tab) return [];
		return tab.console.map(e => ({ ...e, tabId }));
	}

	get network(): NetworkEntry[] {
		const all: NetworkEntry[] = [];
		for (const tab of this.tabs.values()) {
			for (const e of tab.network) all.push({ ...e, tabId: tab.tabId });
		}
		return all.sort((a, b) => a.timestamp - b.timestamp);
	}

	networkForTab(tabId: string): NetworkEntry[] {
		const tab = this.tabs.get(tabId);
		if (!tab) return [];
		return tab.network.map(e => ({ ...e, tabId }));
	}

	clearNetwork(tabId?: string): void {
		if (tabId) {
			this.tabs.get(tabId)?.clearNetwork();
			return;
		}
		for (const tab of this.tabs.values()) tab.clearNetwork();
	}

	get downloads(): DownloadEntry[] {
		const all: DownloadEntry[] = [];
		for (const tab of this.tabs.values()) {
			for (const e of tab.downloads) all.push({ ...e, tabId: tab.tabId });
		}
		return all.sort((a, b) => a.startedAt - b.startedAt);
	}

	downloadsForTab(tabId: string): DownloadEntry[] {
		const tab = this.tabs.get(tabId);
		if (!tab) return [];
		return tab.downloads.map(e => ({ ...e, tabId }));
	}

	/** Aggregated child sessions across all tabs, stamped with tabId. */
	get children(): Array<{ sessionId: string; type: string; url: string; tabId: string }> {
		const all: Array<{ sessionId: string; type: string; url: string; tabId: string }> = [];
		for (const tab of this.tabs.values()) {
			for (const c of tab.children) all.push({ ...c, tabId: tab.tabId });
		}
		return all;
	}

	/** Aggregated event counts across all tabs. */
	get events(): Record<string, number> {
		const merged: Record<string, number> = {};
		for (const tab of this.tabs.values()) {
			for (const [method, count] of Object.entries(tab.events)) {
				merged[method] = (merged[method] ?? 0) + count;
			}
		}
		return merged;
	}

	/** Diagnostic: pageSessionId of the active tab. */
	get pageSessionId(): string | null {
		return this.getTab()?.pageSessionId ?? null;
	}

	async dispose(): Promise<void> {
		for (const tab of this.tabs.values()) {
			tab.dispose();
		}
		this.tabs.clear();
		this.tabSubscriptions.forEach(s => s.dispose());
		this.tabSubscriptions.clear();
		this._activeTabId = null;
		this._onStateChange.dispose();
	}
}
