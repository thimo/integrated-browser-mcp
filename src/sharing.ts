import * as vscode from 'vscode';
import type { OutputChannel } from 'vscode';
import type { CDPManager } from './cdp';

/**
 * Opt-in restriction of the bridge to the tabs it opened itself
 * (`browserBridge.enforceSharing`, default off).
 *
 * Why this shape: the proposed `browser` API the bridge attaches through exposes
 * **no** sharing state — `BrowserTab` is only `url`/`title`/`icon`/
 * `startCDPSession()`/`close()`, and there is no unshare event. VS Code's page
 * sharing is Copilot's own consent gate and is invisible here. Rather than infer
 * consent from a freeform `list_browser_pages` listing matched by URL (a URL
 * identifies content, not a principal — a page can navigate itself to a "shared"
 * URL to acquire access), enforcement is simply: **the agent drives only tabs
 * the bridge opened**. Predictable, works on every build, and no untrusted page
 * text feeds an access decision. When on, the user's own adopted tabs are not
 * driven; `browser_tab_open` / `browser_navigate` create bridge-owned tabs.
 */

export function isEnforcementEnabled(): boolean {
	return vscode.workspace.getConfiguration('browserBridge').get<boolean>('enforceSharing', false);
}

/**
 * Join key for cross-referencing a discovered page with a bridge tab by URL
 * (display only, in `/pages`; NOT an access decision). Lowercase origin
 * (scheme+host, case-insensitive); keep path/query case; drop fragment and a
 * trailing slash. protocol+host, not `u.origin`, so opaque schemes
 * (chrome://, about:) keep their host instead of collapsing to "null".
 */
export function normalizeUrl(url: string): string {
	try {
		const u = new URL(url);
		return (u.protocol + '//' + u.host).toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search;
	} catch {
		return url.replace(/#.*$/, '').replace(/\/+$/, '');
	}
}

/**
 * Detach every tab the bridge did not open itself, when
 * `browserBridge.enforceSharing` is on. Shared by the HTTP guard and the
 * language-model tools so both honour the same access model. No-op when off.
 */
export async function enforceSharing(cdp: CDPManager, log?: OutputChannel): Promise<void> {
	if (!isEnforcementEnabled()) return;
	for (const info of cdp.list()) {
		const tab = cdp.getTab(info.tabId);
		if (!tab || tab.bridgeOwned) continue;
		await cdp.revokeTab(info.tabId, 'browserBridge.enforceSharing is on: the bridge drives only tabs it opened itself');
	}
}
