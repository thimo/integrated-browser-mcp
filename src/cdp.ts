import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CDPTab, CDPState, ConsoleEntry, NetworkEntry, DownloadEntry } from './cdp-tab';

export { CDPState, ConsoleEntry, NetworkEntry, DownloadEntry };

export interface TabInfo {
	tabId: string;
	/**
	 * 1-indexed number shown in the tab title for tabs the bridge opened.
	 * `null` for tabs the user opened — those are never marked, so a number
	 * would refer to something invisible. Freed and reused when a tab closes.
	 */
	number: number | null;
	url: string;
	title: string;
	/** Favicon URI when VS Code exposes one. */
	icon?: string;
	active: boolean;
	state: CDPState;
	transport: 'websocket' | 'browserTab' | null;
}

function generateTabId(): string {
	return 'tab-' + crypto.randomBytes(4).toString('hex');
}

/**
 * True when the `browser` API proposal is both declared *and granted*.
 *
 * Declaring it in package.json is not enough — VS Code only grants it in
 * extension development mode or when launched with
 * `--enable-proposed-api thimo.integrated-browser-mcp`. When declared but
 * ungranted the members still exist on the namespace and throw on access, so a
 * bare `typeof` probe reports a false positive. Probe a property too and treat
 * any throw as "not available".
 */
export function hasProposedBrowserApi(): boolean {
	try {
		const win = vscode.window as unknown as { openBrowserTab?: unknown; browserTabs?: unknown };
		if (typeof win.openBrowserTab !== 'function') return false;
		return Array.isArray(win.browserTabs);
	} catch {
		return false;
	}
}

export type TabIndicatorMode = 'off' | 'marker' | 'number';

/**
 * How to mark a tab that is under agent control.
 *
 * Marking a tab means rewriting the page's real `document.title` through an
 * injected script — the only lever an extension has over the editor tab label
 * — so the page can observe it. That is acceptable on a tab the bridge opened
 * itself, and intrusive on one the user opened, which is why marking is scoped
 * to bridge-owned tabs (see {@link CDPManager.indicatorPrefixFor}).
 *
 *  - `number` — `(N) `, so a user can say "reload browser 2" and match it to
 *    `browser_tab_list`'s `number`.
 *  - `marker` — a fixed symbol: the tab is agent-controlled, without implying
 *    an ordering or renumbering as tabs come and go.
 *  - `off` — never touch titles.
 */
function tabIndicatorMode(): TabIndicatorMode {
	const value = vscode.workspace.getConfiguration('browserBridge').get<string>('tabIndicator', 'number');
	return value === 'off' || value === 'marker' || value === 'number' ? value : 'number';
}

function tabIndicatorText(): string {
	const raw = vscode.workspace.getConfiguration('browserBridge').get<string>('tabIndicatorText', '●');
	// The setting offers bare symbols so the dropdown reads cleanly (a trailing
	// space would be invisible there), but the prefix needs one to separate it
	// from the title. Normalising also keeps older settings that already
	// included the space working.
	const token = raw.trim();
	return token ? `${token} ` : '● ';
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

	/**
	 * The title prefix a tab should carry, or null for "leave the title alone".
	 *
	 * Only bridge-owned tabs are marked. The bridge attaches to *every*
	 * integrated browser tab in the window, so marking on adoption stamped a
	 * prefix onto pages the user had opened themselves — their title, their
	 * page, mutated because an unrelated tool happened to be running. The tab
	 * still gets a `number` in `browser_tab_list` either way; this only governs
	 * what is written into the document.
	 */
	private indicatorPrefixFor(tab: CDPTab): string | null {
		if (!tab.bridgeOwned) return null;
		const mode = tabIndicatorMode();
		if (mode === 'off') return null;
		if (mode === 'marker') return tabIndicatorText();
		return tab.displayNumber !== null ? numberToPrefix(tab.displayNumber) : tabIndicatorText();
	}

	/**
	 * Re-apply or clear indicators after a settings change. Without this,
	 * turning the setting off would leave every already-marked page with a
	 * polluted title until it was reopened.
	 */
	async refreshIndicators(): Promise<void> {
		for (const tab of this.tabs.values()) {
			const prefix = this.indicatorPrefixFor(tab);
			try {
				if (prefix) await tab.setTitlePrefix(prefix, this.ownerId);
				else await tab.removeTitlePrefix();
			} catch (err) {
				this.log.appendLine(`[Bridge] Indicator refresh failed for ${tab.tabId}: ${err}`);
			}
		}
	}

	/**
	 * Record that the bridge owns this tab after the fact, applying the
	 * indicator that the earlier (unowned) adoption skipped. Idempotent.
	 */
	private async claimOwnership(tab: CDPTab): Promise<CDPTab> {
		if (tab.bridgeOwned) return tab;
		tab.bridgeOwned = true;
		// Adopted before ownership was known, so it has no number yet.
		if (tab.displayNumber === null) tab.displayNumber = this.allocateNumber();
		const prefix = this.indicatorPrefixFor(tab);
		if (prefix) await tab.setTitlePrefix(prefix, this.ownerId);
		return tab;
	}

	/**
	 * Lowest unused number, so closing a tab frees its slot for the next one:
	 * with 1 and 2 open, closing 1 means the next tab is 1 again rather than 3.
	 * Only bridge-owned tabs hold a number, so the sequence has no invisible gaps.
	 */
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
			icon: tab.iconUri,
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
	async openTab(url: string, makeActive = true, beside = false): Promise<CDPTab> {
		if (!hasProposedBrowserApi()) {
			throw new Error(
				'Multi-tab is unavailable in this build: the `browser` API proposal is declared but not granted, '
				+ 'so new tabs cannot be opened and existing pages cannot be attached to. '
				+ 'Relaunch VS Code with `--enable-proposed-api thimo.integrated-browser-mcp` to enable it. '
				+ 'Without it, call browser_navigate with no tabId — the bridge lazy-launches its own single tab and drives that.',
			);
		}
		// `preserveFocus` alone only keeps *keyboard* focus — the new tab still
		// becomes the visible editor, flipping the user's view. `background` is
		// what actually leaves their tab in front, and it is the whole point of
		// `makeActive: false`: an agent following the "open your own tab, don't
		// disturb the user" practice must not hijack the screen to do it.
		const browserTab = await vscode.window.openBrowserTab('about:blank', {
			preserveFocus: !makeActive,
			background: !makeActive,
			// Opt-in only: splitting the editor group is itself disruptive, so
			// the default stays in the current group.
			...(beside ? { viewColumn: vscode.ViewColumn.Beside } : {}),
		});
		const tab = await this.adoptBrowserTab(browserTab, makeActive, true);
		if (url !== 'about:blank') {
			await tab.send('Page.navigate', { url });
			// Don't return until the tab reports the destination. Returning
			// straight after `Page.navigate` reported `about:blank` for a page
			// that loaded correctly a moment later, so callers misdescribed
			// what they had just opened.
			await tab.settleNavigation();
		}
		return tab;
	}

	/**
	 * Wrap an existing {@link vscode.BrowserTab} in a {@link CDPTab} and start
	 * its CDP session. Idempotent: returns the existing wrapper if already
	 * tracked. Called both for tabs we created via {@link openTab} and for
	 * tabs the user opened via VS Code UI (via `onDidOpenBrowserTab`).
	 */
	async adoptBrowserTab(browserTab: vscode.BrowserTab, makeActive = false, bridgeOwned = false): Promise<CDPTab> {
		// An in-flight adoption takes priority: a concurrent caller must wait
		// for the connect + title-prefix to finish, not grab the half-built
		// tab reference from the map.
		// Ownership has to be upgradeable, not just set at construction.
		// `onDidOpenBrowserTab` fires for tabs we open ourselves and calls this
		// without `bridgeOwned`, so whichever call arrives first decides — and
		// the event usually wins. A tab the bridge opened would then be recorded
		// as the user's: no indicator, and under `enforceSharing` it would be
		// revoked as an unshared page the bridge had no business driving.
		const pending = this.pendingAdoptions.get(browserTab);
		if (pending) return bridgeOwned ? pending.then(tab => this.claimOwnership(tab)) : pending;
		for (const tab of this.tabs.values()) {
			if (tab.browserTab === browserTab) return bridgeOwned ? this.claimOwnership(tab) : tab;
		}
		const promise = (async () => {
			const tab = new CDPTab(generateTabId(), this.log);
			tab.bridgeOwned = bridgeOwned;
			// Only the bridge's own tabs are numbered. Numbering everything
			// meant the user's tabs silently consumed 1 and 2 while showing no
			// prefix, so the agent's first tab appeared as "(3)" — a number the
			// user cannot see the origin of, with no visible 1 or 2 to match.
			tab.displayNumber = bridgeOwned ? this.allocateNumber() : null;
			this.registerTab(tab);
			await tab.connectToBrowserTab(browserTab);

			// No bridge-level ownership handshake: the proposed API is
			// per-window, so two bridges never see the same tab. The check
			// we used to have here blocked legitimate reclaim after a window
			// reload (previous instance leaves a stale `window.__bridgeOwner`
			// in the page JS; a fresh instance must be allowed to take over).
			// The title-script's own loop-detection backs off cleanly if it
			// does somehow end up fighting a stale observer.

			const prefix = this.indicatorPrefixFor(tab);
			if (prefix) await tab.setTitlePrefix(prefix, this.ownerId);
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
		// The fallback path's single tab is launched by the bridge itself, so
		// it is bridge-owned — otherwise sharing enforcement would revoke it
		// immediately and leave the extension with nothing to drive.
		tab.bridgeOwned = true;
		tab.displayNumber = 1;
		this.registerTab(tab);
		await tab.connectToSession(session);
		const prefix = this.indicatorPrefixFor(tab);
		if (prefix) await tab.setTitlePrefix(prefix, this.ownerId);
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
		// trigger untrack via onDidCloseBrowserTab. On the fallback path the
		// tab is owned by a debug session — disconnecting CDP alone left the
		// browser editor open, so the page stayed in VS Code (and in
		// `list_browser_pages`' unshared count) despite us reporting it closed.
		// Terminating the session is what actually closes it.
		const underlying = tab.browserTab;
		const session = tab.debugSession;
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
		} else if (session) {
			try { await vscode.debug.stopDebugging(session); } catch { /* already gone */ }
		}
		this.emitStateChange();
	}

	/**
	 * Tabs detached because their page stopped being shared. Kept so a call
	 * against a stale `tabId` fails with the real reason instead of a generic
	 * "no tab" — an agent must be able to tell "revoked" from "never existed".
	 */
	private revoked = new Map<string, { url: string; reason: string; at: number }>();

	/** Cap on remembered revocations, so enforceSharing churn can't grow the map without bound. */
	private static readonly MAX_REVOKED = 100;

	revokedReason(tabId: string): string | undefined {
		return this.revoked.get(tabId)?.reason;
	}

	/**
	 * Detach from a tab the user unshared. Deliberately does NOT close the
	 * page — it is the user's, and revoking access must not destroy their work.
	 */
	async revokeTab(tabId: string, reason: string): Promise<void> {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		const url = tab.url;
		this.log.appendLine(`[Bridge] Revoking ${tabId} (${url}): ${reason}`);
		try { await tab.disconnect(); } catch { /* already gone */ }
		tab.dispose();
		this.tabSubscriptions.get(tabId)?.dispose();
		this.tabSubscriptions.delete(tabId);
		this.tabs.delete(tabId);
		if (this._activeTabId === tabId) {
			this._activeTabId = this.tabs.size > 0 ? this.tabs.keys().next().value ?? null : null;
		}
		this.revoked.set(tabId, { url, reason, at: Date.now() });
		// FIFO-evict the oldest so a long session under enforceSharing (every
		// user tab adopted then revoked) can't grow this without bound.
		while (this.revoked.size > CDPManager.MAX_REVOKED) {
			const oldest = this.revoked.keys().next().value;
			if (oldest === undefined) break;
			this.revoked.delete(oldest);
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

	/** Route a VS Code tab-state change (url/title/icon) to its CDPTab. */
	notifyBrowserTabState(browserTab: vscode.BrowserTab): void {
		for (const tab of this.tabs.values()) {
			if (tab.browserTab === browserTab) {
				tab.notifyBrowserTabStateChanged();
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
