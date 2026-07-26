import * as vscode from 'vscode';
import type { OutputChannel } from 'vscode';
import { discoverPages } from './lm-pages';
import type { CDPManager } from './cdp';

/**
 * Opt-in enforcement of VS Code's page-sharing state as this bridge's access
 * model (`browserBridge.enforceSharing`).
 *
 * Why this is opt-in and best-effort: the proposed `browser` API the bridge
 * attaches through exposes **no** sharing state — `BrowserTab` is only
 * `url`/`title`/`icon`/`startCDPSession()`/`close()`. There is no unshare
 * event to subscribe to. The single available signal is the
 * `list_browser_pages` language model tool, which requires VS Code 1.131+ *and*
 * chat enabled. So enforcement is a poll of that listing, matched by URL.
 *
 * Consequences worth knowing before turning it on:
 *  - With no signal (chat disabled, older VS Code) sharing cannot be expressed
 *    at all — there is no share button to press — so the bridge fails
 *    **closed to bridge-owned tabs**: it drives only what it opened itself,
 *    and the user's own tabs are neither accessible nor grantable. Failing
 *    open would hand over pages that were never consented to. `/status`
 *    reports `bridge-owned-only` in that mode.
 *  - Matching is by normalized URL, because page ids and tab ids share no
 *    namespace. Two tabs on the same URL are indistinguishable.
 *  - Revocation is bounded by the poll TTL below, not instantaneous.
 */

/** Cache window. Bounds how long a just-unshared page stays drivable. */
const TTL_MS = 2000;

let cache: { at: number; urls: Set<string>; available: boolean; failed: boolean } | null = null;

export function isEnforcementEnabled(): boolean {
	return vscode.workspace.getConfiguration('browserBridge').get<boolean>('enforceSharing', false);
}

/**
 * Page ids and tab ids share no namespace, so URL is the only join key.
 * Lowercase only the origin (scheme+host, which are case-insensitive); keep the
 * path and query case-sensitive so `/Admin` and `/admin` stay distinct, and drop
 * the fragment (same page) and a trailing slash so hash/slash drift doesn't
 * spuriously mismatch a shared page.
 */
export function normalizeUrl(url: string): string {
	try {
		const u = new URL(url);
		return u.origin.toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search;
	} catch {
		return url.replace(/#.*$/, '').replace(/\/+$/, '');
	}
}

/** Set of currently-shared page URLs, cached briefly. `failed` = the tool errored (not "nothing shared"). */
export async function sharedUrls(log?: vscode.OutputChannel): Promise<{ urls: Set<string>; available: boolean; failed: boolean }> {
	const now = Date.now();
	if (cache && now - cache.at < TTL_MS) return cache;

	const discovery = await discoverPages(log);
	const urls = new Set<string>();
	for (const page of discovery.pages) {
		if (page.url) urls.add(normalizeUrl(page.url));
	}
	cache = { at: now, urls, available: discovery.available, failed: discovery.failed === true };
	return cache;
}

/**
 * Detach any user-owned tab whose page is no longer shared, when
 * `browserBridge.enforceSharing` is on. Shared by the HTTP guard and the
 * language-model tools so both honour the same access model.
 *
 * Fails SAFE: on a transient discovery failure (timeout/parse error) it skips
 * revocation entirely rather than mass-revoking every user tab on one hiccup.
 * When discovery is genuinely unavailable (disabled or VS Code < 1.131) it
 * falls closed to bridge-owned-only, which is the documented mode.
 */
export async function enforceSharing(cdp: CDPManager, log?: OutputChannel): Promise<void> {
	if (!isEnforcementEnabled()) return;
	let signal: { urls: Set<string>; available: boolean; failed: boolean };
	try {
		signal = await sharedUrls(log);
	} catch (err) {
		log?.appendLine(`[Bridge] Sharing check failed, leaving tabs as-is: ${err}`);
		return;
	}
	// A transient failure is not "nothing is shared" — do not revoke on it.
	if (signal.failed) {
		log?.appendLine('[Bridge] Sharing listing failed this cycle; not revoking (fail-safe).');
		return;
	}
	for (const info of cdp.list()) {
		const tab = cdp.getTab(info.tabId);
		// Tabs the bridge opened are its own — always accessible.
		if (!tab || tab.bridgeOwned) continue;
		if (signal.available && info.url && signal.urls.has(normalizeUrl(info.url))) continue;
		await cdp.revokeTab(
			info.tabId,
			signal.available
				? 'page no longer shared'
				: 'sharing cannot be expressed here (needs VS Code 1.131+ with chat and browserBridge.lmPageDiscovery on), so only bridge-opened tabs are accessible',
		);
	}
}

/** Drop the cache so the next check re-reads sharing state immediately. */
export function invalidateSharingCache(): void {
	cache = null;
}
