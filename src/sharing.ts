import * as vscode from 'vscode';
import { discoverPages } from './lm-pages';

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

let cache: { at: number; urls: Set<string>; available: boolean } | null = null;

export function isEnforcementEnabled(): boolean {
	return vscode.workspace.getConfiguration('browserBridge').get<boolean>('enforceSharing', false);
}

/** Page ids and tab ids share no namespace, so URL is the only join key. */
export function normalizeUrl(url: string): string {
	return url.replace(/\/+$/, '').toLowerCase();
}

/** Set of currently-shared page URLs, cached briefly. */
export async function sharedUrls(log?: vscode.OutputChannel): Promise<{ urls: Set<string>; available: boolean }> {
	const now = Date.now();
	if (cache && now - cache.at < TTL_MS) return cache;

	const discovery = await discoverPages(log);
	const urls = new Set<string>();
	for (const page of discovery.pages) {
		if (page.url) urls.add(normalizeUrl(page.url));
	}
	cache = { at: now, urls, available: discovery.available };
	return cache;
}

/** Drop the cache so the next check re-reads sharing state immediately. */
export function invalidateSharingCache(): void {
	cache = null;
}
