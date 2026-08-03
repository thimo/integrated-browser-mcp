import * as vscode from 'vscode';
import type { CDPManager } from './cdp';

/**
 * Which tabs an agent is allowed to drive
 * (`integratedBrowserMcp.allowAllExistingTabs`, default off — the bridge drives
 * only tabs it opened itself).
 *
 * Why this shape: the proposed `browser` API the bridge attaches through exposes
 * **no** sharing state — `BrowserTab` is only `url`/`title`/`icon`/
 * `startCDPSession()`/`close()`, and there is no unshare event. VS Code's page
 * sharing is Copilot's own consent gate and is invisible here. Rather than infer
 * consent from a freeform `list_browser_pages` listing matched by URL (a URL
 * identifies content, not a principal — a page can navigate itself to a "shared"
 * URL to acquire access), the rule is simply: **the agent drives only tabs the
 * bridge opened**. Predictable, works on every build, and no untrusted page text
 * feeds an access decision.
 *
 * Default-deny because installing an extension should not silently expose every
 * page already open in the integrated browser to whatever agent connects. Turn
 * `allowAllExistingTabs` on to let agents work in tabs you opened yourself.
 */

/** The explicitly-configured value at any scope, or undefined if never set. */
function explicitValue<T>(scoped: { workspaceFolderValue?: T; workspaceValue?: T; globalValue?: T } | undefined): T | undefined {
	return scoped?.workspaceFolderValue ?? scoped?.workspaceValue ?? scoped?.globalValue;
}

/**
 * True when the bridge may drive tabs the user opened. Default false.
 *
 * Migrates the former `enforceSharing`, which expressed the same choice
 * inverted: someone who set `enforceSharing: true` wanted the restriction and
 * gets it, and someone who explicitly set it to `false` wanted the permissive
 * behaviour and keeps it. Never having touched it now means default-deny.
 */
export function allowsAllExistingTabs(): boolean {
	const config = vscode.workspace.getConfiguration();
	const current = explicitValue(config.inspect<boolean>('integratedBrowserMcp.allowAllExistingTabs'));
	if (current !== undefined) return current;
	const legacy = explicitValue(config.inspect<boolean>('integratedBrowserMcp.enforceSharing'))
		?? explicitValue(config.inspect<boolean>('browserBridge.enforceSharing'));
	if (legacy !== undefined) return !legacy;
	return false;
}

/**
 * Detach every tab the bridge did not open itself, unless
 * `integratedBrowserMcp.allowAllExistingTabs` is on. Shared by the HTTP guard and
 * the language-model tools so both honour the same access model, and run before
 * every read as well as every interaction: revoking drops the tab's buffered
 * console and network entries out of the aggregate along with it.
 */
export async function enforceTabAccess(cdp: CDPManager): Promise<void> {
	if (allowsAllExistingTabs()) return;
	for (const info of cdp.list()) {
		const tab = cdp.getTab(info.tabId);
		if (!tab || tab.bridgeOwned) continue;
		// Reason only — callers append the remedy, so naming the setting here
		// too would say it twice in one message.
		await cdp.revokeTab(info.tabId, 'the bridge drives only tabs it opened itself');
	}
}
