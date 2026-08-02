import * as vscode from 'vscode';
import type { CDPManager } from './cdp';

/**
 * Opt-in restriction of the bridge to the tabs it opened itself
 * (`integratedBrowserMcp.enforceSharing`, default off).
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
	return vscode.workspace.getConfiguration('integratedBrowserMcp').get<boolean>('enforceSharing', false);
}

/**
 * Detach every tab the bridge did not open itself, when
 * `integratedBrowserMcp.enforceSharing` is on. Shared by the HTTP guard and the
 * language-model tools so both honour the same access model. No-op when off.
 */
export async function enforceSharing(cdp: CDPManager): Promise<void> {
	if (!isEnforcementEnabled()) return;
	for (const info of cdp.list()) {
		const tab = cdp.getTab(info.tabId);
		if (!tab || tab.bridgeOwned) continue;
		await cdp.revokeTab(info.tabId, 'integratedBrowserMcp.enforceSharing is on: the bridge drives only tabs it opened itself');
	}
}
