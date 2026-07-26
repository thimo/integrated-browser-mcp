import * as vscode from 'vscode';
import { hasProposedBrowserApi } from './cdp';

/**
 * Page discovery via VS Code's built-in `list_browser_pages` language model
 * tool (VS Code 1.131+ / Insiders, microsoft/vscode#326976).
 *
 * Why this exists alongside the CDP path: the bridge only knows about tabs it
 * has adopted. On the proposed-`browser`-API path that's every integrated
 * browser tab in the window; on the debug-session fallback it's just the one
 * tab the bridge launched itself. Neither sees pages the *user* opened, or
 * pages owned by another window. `list_browser_pages` asks VS Code directly,
 * so agents can tell "there is a page open that I'm not attached to" apart
 * from "there is no such page".
 *
 * This is deliberately discovery-only. Everything the bridge actually *does*
 * to a page (console/network buffering, downloads, emulation, eval) stays on
 * CDP — the LM browser tools have no equivalent for any of it, and
 * `run_playwright_code` is one-shot so it can't hold event listeners.
 *
 * Safety note: `list_browser_pages` declares no `confirmationMessages`, so
 * unlike `open_browser_page` / `navigate_page` / `run_playwright_code` it does
 * NOT raise a modal when invoked without a chat session. No auto-approve
 * setting is required for this call path.
 */

export const LIST_PAGES_TOOL = 'list_browser_pages';

/** How long to wait on the tool before giving up (it is a local, synchronous read). */
const INVOKE_TIMEOUT_MS = 5000;

export interface DiscoveredPage {
	/** Opaque VS Code page id. Not interchangeable with the bridge's `tabId`. */
	pageId: string;
	title: string;
	/** `null` when VS Code masked the URL under network domain policy. */
	url: string | null;
	/** Editor visibility hint, as reported by VS Code. */
	visibility: 'active' | 'visible' | 'not visible' | null;
	/** True when the page's title/URL were withheld by network domain policy. */
	blocked: boolean;
	/** Bridge tab serving the same URL, when one can be matched. */
	attachedTabId?: string;
}

export interface PageDiscovery {
	available: boolean;
	/**
	 * True only when the tool was invoked and errored/timed out (transient),
	 * as opposed to being disabled or unsupported. Enforcement must not treat a
	 * transient failure as "nothing is shared" and mass-revoke.
	 */
	failed?: boolean;
	/** Why discovery is unavailable — omitted when `available` is true. */
	reason?: string;
	/** Hints for enabling it, when unavailable. */
	requires?: string[];
	/** Pages VS Code reports as shared with agents. */
	pages: DiscoveredPage[];
	/** Pages open but not shared with agents (VS Code reports only a count). */
	unsharedCount: number;
	/** Tool output, with VS Code's chat-only guidance stripped. See {@link sanitizeRaw}. */
	raw?: string;
	/** What the caller should actually do next, in terms of tools this bridge exposes. */
	hint?: string;
}

/**
 * VS Code's listing ends with guidance aimed at Copilot's own toolset, e.g.
 * "Use the 'open_browser_page' tool to open a new page." That tool does not
 * exist here, but the text sits inside a tool result and so reads as
 * authoritative — an agent will try to call it and dead-end. Strip any line
 * naming a tool we do not expose; `hint` carries correct guidance instead.
 */
export function sanitizeRaw(text: string): string {
	return text
		.split('\n')
		.filter(line => !/\b(open_browser_page|read_page|screenshot_page|navigate_page|click_element|type_in_page|run_playwright_code)\b/.test(line))
		.join('\n')
		.trim();
}

const UNAVAILABLE_REQUIREMENTS = [
	'VS Code 1.131+ (Insiders) — the tool landed in microsoft/vscode#326976',
	'chat enabled and signed in',
	'"chat.agent.enabled": true',
	'"workbench.browser.enableChatTools": true',
];

function unavailable(reason: string): PageDiscovery {
	return { available: false, reason, requires: UNAVAILABLE_REQUIREMENTS, pages: [], unsharedCount: 0 };
}

/** True when this VS Code build exposes the `list_browser_pages` tool. */
export function isDiscoveryAvailable(): boolean {
	const lm = (vscode as { lm?: { tools?: readonly { name: string }[]; invokeTool?: unknown } }).lm;
	if (!lm || typeof lm.invokeTool !== 'function' || !Array.isArray(lm.tools)) return false;
	return lm.tools.some(tool => tool.name === LIST_PAGES_TOOL);
}

/** True when the user has opted in via `browserBridge.lmPageDiscovery`. Off by default until the 1.131 path has been verified first-hand. */
export function isDiscoveryEnabled(): boolean {
	return vscode.workspace.getConfiguration('browserBridge').get<boolean>('lmPageDiscovery', false);
}

/**
 * Pull the text out of a LanguageModelToolResult. Parts are matched
 * structurally rather than with `instanceof`, so a version skew in the
 * LanguageModelTextPart class identity can't silently yield an empty string.
 */
function resultToText(result: vscode.LanguageModelToolResult): string {
	const parts = (result?.content ?? []) as unknown[];
	const chunks: string[] = [];
	for (const part of parts) {
		if (typeof part === 'string') {
			chunks.push(part);
		} else if (part && typeof part === 'object' && typeof (part as { value?: unknown }).value === 'string') {
			chunks.push((part as { value: string }).value);
		}
	}
	return chunks.join('\n').trim();
}

/**
 * Parse one `- [pageId] Title (url) (active)` line.
 *
 * The URL is taken as the LAST parenthesised group so that titles containing
 * parentheses parse correctly. Pages masked by network policy have no URL
 * group at all — those come back with `url: null` and `blocked: true`.
 */
function parsePageLine(line: string): DiscoveredPage | null {
	const match = line.match(/^[-*]\s*\[([^\]]+)\]\s*(.*)$/);
	if (!match) return null;

	const pageId = match[1].trim();
	let rest = match[2].trim();
	if (!pageId) return null;

	let visibility: DiscoveredPage['visibility'] = null;
	const hint = rest.match(/\s*\((active|visible|not visible)\)$/);
	if (hint) {
		visibility = hint[1] as DiscoveredPage['visibility'];
		rest = rest.slice(0, hint.index).trimEnd();
	}

	let url: string | null = null;
	let title = rest;
	if (rest.endsWith(')')) {
		const open = rest.lastIndexOf(' (');
		if (open !== -1) {
			url = rest.slice(open + 2, -1).trim();
			title = rest.slice(0, open).trim();
		}
	}

	const blocked = url === null && /blocked by network domain policy/i.test(title);
	return { pageId, title, url, visibility, blocked };
}

/** Parse the tool's freeform text into structured pages. */
export function parsePageListing(text: string): { pages: DiscoveredPage[]; unsharedCount: number } {
	const pages: DiscoveredPage[] = [];
	let unsharedCount = 0;

	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const page = parsePageLine(trimmed);
		if (page) {
			pages.push(page);
			continue;
		}

		// "1 page is open but not shared." / "3 pages are open but not shared."
		const unshared = trimmed.match(/^(\d+)\s+pages?\s+(?:is|are)\s+open but not shared/i);
		if (unshared) unsharedCount = Number(unshared[1]);
	}

	return { pages, unsharedCount };
}

/**
 * Explain, in terms of tools this bridge actually exposes, how to act on what
 * was discovered. Discovery reports pages VS Code knows about; whether any of
 * them can be *driven* depends on the `browser` API proposal, so the honest
 * answer differs per build.
 */
function buildHint(pageCount: number, unsharedCount: number): string {
	const parts: string[] = [];

	if (hasProposedBrowserApi()) {
		if (pageCount > 0) {
			parts.push('Pages in this window are attached automatically; use browser_tab_list for the drivable tabs and pass their tabId.');
		}
		// Discovery honours unshare but the CDP attachment does not, and that
		// split is invisible from the listing alone. Say it here so nobody
		// reads "no longer listed" as "no longer reachable".
		parts.push(
			'Note: this listing reflects VS Code\'s sharing state, which does NOT control bridge access. '
			+ 'A page that stops being listed after the user unshares it is still attached and still drivable via its tabId. '
			+ 'If the user asks you to stop using a page, stop using it — and tell them the page must be closed to actually revoke access.',
		);
	} else {
		parts.push(
			'DEGRADED — the listing above is VS Code\'s own text and overstates what this bridge can do: pages described as '
			+ '"shared with you and can be interacted with" CANNOT be driven here. '
			+ 'This build cannot attach to pages it did not open: the `browser` API proposal is declared but not granted, '
			+ 'so discovered pages have no attachedTabId and browser_tab_open is unavailable. '
			+ 'To act on a page, call browser_navigate with its url and NO tabId — the bridge lazy-launches its own single tab at that URL '
			+ '(this does not take over the user\'s page; it opens a separate one). '
			+ 'For direct control of existing pages, relaunch VS Code with `--enable-proposed-api thimo.integrated-browser-mcp`.',
		);
	}

	if (unsharedCount > 0 && pageCount === 0) {
		parts.push(`${unsharedCount} page(s) are open but not shared with agents; the user must share one from the VS Code UI before it appears here.`);
	}

	return parts.join(' ');
}

/**
 * Ask VS Code which integrated browser pages exist. Never throws — an
 * unavailable or failing tool comes back as `available: false` with a reason,
 * so callers can surface the gap without special-casing older builds.
 */
export async function discoverPages(log?: vscode.OutputChannel): Promise<PageDiscovery> {
	if (!isDiscoveryEnabled()) {
		return { available: false, reason: 'Disabled via browserBridge.lmPageDiscovery', pages: [], unsharedCount: 0 };
	}
	if (!isDiscoveryAvailable()) {
		return unavailable(`This VS Code build does not expose the '${LIST_PAGES_TOOL}' language model tool`);
	}

	const cts = new vscode.CancellationTokenSource();
	const timer = setTimeout(() => cts.cancel(), INVOKE_TIMEOUT_MS);
	try {
		const result = await vscode.lm.invokeTool(
			LIST_PAGES_TOOL,
			{ input: {}, toolInvocationToken: undefined },
			cts.token,
		);
		const raw = resultToText(result);
		const { pages, unsharedCount } = parsePageListing(raw);
		return { available: true, pages, unsharedCount, raw: sanitizeRaw(raw), hint: buildHint(pages.length, unsharedCount) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log?.appendLine(`[LM] ${LIST_PAGES_TOOL} failed: ${message}`);
		return { available: false, failed: true, reason: message, pages: [], unsharedCount: 0 };
	} finally {
		clearTimeout(timer);
		cts.dispose();
	}
}
