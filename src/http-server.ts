import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import express from 'express';
import type { CDPManager } from './cdp';
import type { CDPTab, DownloadBehavior } from './cdp-tab';
import type * as vscode from 'vscode';
import { discoverPages, isDiscoveryAvailable, isDiscoveryEnabled, type DiscoveredPage } from './lm-pages';
import { hasProposedBrowserApi } from './cdp';
import { isEnforcementEnabled, normalizeUrl, sharedUrls } from './sharing';
import { decodePng, pixelAt } from './png';

const DOWNLOAD_BEHAVIORS: ReadonlySet<DownloadBehavior> = new Set(['allow', 'allowAndName', 'deny', 'default']);

/**
 * Named cause + remedy for the degraded path, repeated verbatim in `/status`
 * and in every error raised while degraded. A silent fallback previously cost
 * an entire debugging session: shared pages never became attachable,
 * `browser_tab_open` failed with raw internal text, and discovery text claimed
 * pages "can be interacted with" when they could not — all of which read as
 * extension bugs rather than one missing flag.
 */
const DEGRADED_WARNING =
	'DEGRADED: the `browser` API proposal is declared but not granted, so the bridge is on the debug-session fallback. '
	+ 'Consequences: pages you did not open cannot be attached (no attachedTabId, even once shared), browser_tab_open is unavailable, '
	+ 'and each bridge tab shows a debug toolbar. '
	+ 'Remedy: add "enable-proposed-api": ["thimo.integrated-browser-mcp"] to argv.json (Preferences: Configure Runtime Arguments) '
	+ 'or launch with --enable-proposed-api thimo.integrated-browser-mcp, then fully restart VS Code.';

/** Shape of the nodes CDP returns from `Accessibility.getFullAXTree`. */
interface RawAXNode {
	nodeId: string;
	ignored?: boolean;
	role?: { value?: unknown };
	name?: { value?: unknown };
	value?: { value?: unknown };
	description?: { value?: unknown };
	childIds?: string[];
	properties?: Array<{ name: string; value?: { value?: unknown } }>;
}

/** Roles an agent can actually act on — the useful subset when `interactiveOnly`. */
const INTERACTIVE_ROLES = new Set([
	'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
	'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider',
	'searchbox', 'spinbutton', 'treeitem',
]);

/**
 * Roles that never carry information of their own: `InlineTextBox` duplicates
 * the text of its parent `StaticText`, and `LineBreak` is pure layout.
 */
const NOISE_ROLES = new Set(['InlineTextBox', 'LineBreak']);

/** Properties worth keeping; the rest is mostly ARIA bookkeeping that bloats the payload. */
const KEPT_PROPERTIES = new Set(['checked', 'disabled', 'expanded', 'focused', 'level', 'pressed', 'required', 'selected']);

function axText(field?: { value?: unknown }): string | undefined {
	const value = field?.value;
	return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Restrict a flat AX node list to `rootId` and everything beneath it. */
export function descendantsOf(nodes: RawAXNode[], rootId: string): RawAXNode[] {
	const byId = new Map(nodes.map(node => [node.nodeId, node]));
	const out: RawAXNode[] = [];
	const seen = new Set<string>();
	const stack = [rootId];
	while (stack.length) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		const node = byId.get(id);
		if (!node) continue;
		out.push(node);
		for (const child of node.childIds ?? []) stack.push(child);
	}
	return out;
}

/**
 * Collapse verbose AX nodes into a compact, agent-readable projection.
 *
 * The raw tree carries a `{value: {type, value}}` wrapper on every field plus a
 * long `properties` array, most of which an agent never reads. Dropping ignored
 * nodes (invisible to assistive tech anyway) and nameless structural nodes is
 * what turns a 291k-character dump into something usable.
 */
export function projectAXNodes(
	nodes: RawAXNode[],
	opts: { includeIgnored?: boolean; interactiveOnly?: boolean } = {},
): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const node of nodes) {
		if (node.ignored && !opts.includeIgnored) continue;

		const role = axText(node.role);
		const name = axText(node.name);
		if (role && NOISE_ROLES.has(role)) continue;
		if (opts.interactiveOnly && !(role && INTERACTIVE_ROLES.has(role))) continue;
		// Unnamed nodes only earn their place if they are actionable: an unnamed
		// button still matters (and flags an a11y gap), but the sea of unnamed
		// `generic` wrappers a component framework emits is pure noise — and is
		// most of what makes a raw SPA tree six figures of characters.
		if (!name && !(role && INTERACTIVE_ROLES.has(role))) continue;

		const entry: Record<string, unknown> = { nodeId: node.nodeId };
		if (role) entry.role = role;
		if (name) entry.name = name;
		const value = axText(node.value);
		if (value) entry.value = value;
		const description = axText(node.description);
		if (description) entry.description = description;

		for (const prop of node.properties ?? []) {
			if (!KEPT_PROPERTIES.has(prop.name)) continue;
			const propValue = prop.value?.value;
			// Skip the defaults — `disabled: false` on every node is pure noise.
			if (propValue === false || propValue === undefined || propValue === '') continue;
			entry[prop.name] = propValue;
		}
		out.push(entry);
	}
	return out;
}

export class BridgeServer {
	private app: express.Application;
	private server: http.Server | null = null;
	private cdp: CDPManager;
	private log: vscode.OutputChannel;
	private ensureBrowser: ((url?: string) => Promise<void>) | null = null;
	private emulatePath: 'emulation' | 'page' | 'unknown' = 'unknown';
	/** Set when listening on a unix socket / named pipe instead of a TCP port. */
	private socketPath: string | null = null;

	constructor(cdp: CDPManager, log: vscode.OutputChannel) {
		this.cdp = cdp;
		this.log = log;
		this.app = express();
		this.app.use(express.json());
		this.setupRoutes();
	}

	setEnsureBrowser(fn: (url?: string) => Promise<void>): void {
		this.ensureBrowser = fn;
	}

	/**
	 * Middleware that ensures at least one tab exists. If none exist, lazy-launches
	 * a browser. For `/navigate` (which has a URL), the launch navigates directly
	 * to the target; other endpoints get about:blank. Errors out if still no tab
	 * after the launch attempt.
	 */
	private requireAnyTab(lazyUrl?: (req: express.Request) => string | undefined): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
		return (req, res, next) => {
			const run = async () => {
				// Enforce before creating or touching anything: /navigate is the
				// most impactful verb, so leaving it unguarded let a caller keep
				// driving a just-unshared tab simply by avoiding other endpoints.
				await this.enforceSharing().catch(() => undefined);
				if (this.cdp.tabCount === 0 && this.ensureBrowser) {
					this.log.appendLine('[HTTP] No tabs, launching browser...');
					await this.ensureBrowser(lazyUrl?.(req));
				}
				if (this.cdp.state !== 'connected') {
					res.json({ ok: false, error: 'CDP not connected' });
					return;
				}
				next();
			};
			run().catch(err => {
				this.log.appendLine(`[HTTP] ensureBrowser error: ${err}`);
				res.json({ ok: false, error: 'Failed to launch browser' });
			});
		};
	}

	/**
	 * Middleware for everything that is not an explicit "create a page" action.
	 *
	 * Reads must not mutate browser state. Lazy-launching from `/url`, `/dom`,
	 * `/snapshot` etc. minted a page, and — because there is no URL to launch
	 * at — dropped the user into VS Code's new-tab URL prompt, blocking a
	 * read on a human. Worse, cancelling that prompt still yielded a live
	 * `about:blank` tab indistinguishable from an accepted one, so an agent
	 * could read `about:blank` and confidently report it as the page state.
	 * Page creation now belongs to `/navigate` and `/tab/open` alone.
	 */
	private requireExistingTab(): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
		return (_req, res, next) => {
			this.enforceSharing()
				.catch(err => this.log.appendLine(`[Bridge] Sharing enforcement failed: ${err}`))
				.then(() => this.afterEnforcement(res, next));
		};
	}

	private afterEnforcement(res: express.Response, next: express.NextFunction): void {
		{
			if (this.cdp.tabCount === 0) {
				res.json({
					ok: false,
					reason: 'no_attached_page',
					error: 'No attached page. This is a read-only call, so the bridge did not create one.',
					hint: 'Call browser_navigate with a url and no tabId to create and attach a page, then retry. browser_tab_list shows attached tabs; browser_status reports capabilities.',
					// Name the cause here too: "no attached page" while degraded
					// usually means the page exists but is unattachable, which
					// is a very different situation from "no page open".
					...(hasProposedBrowserApi() ? {} : { degraded: true, warning: DEGRADED_WARNING }),
				});
				return;
			}
			if (this.cdp.state !== 'connected') {
				res.json({ ok: false, reason: 'not_connected', error: 'CDP not connected' });
				return;
			}
			next();
		};
	}

	/**
	 * Detach from any user-owned tab whose page is no longer shared, when
	 * `browserBridge.enforceSharing` is on. Runs before tab-targeted work so a
	 * revoked page cannot be driven through a `tabId` captured earlier.
	 */
	private async enforceSharing(): Promise<void> {
		if (!isEnforcementEnabled()) return;
		const { urls, available } = await sharedUrls(this.log);
		for (const info of this.cdp.list()) {
			const tab = this.cdp.getTab(info.tabId);
			// Tabs the bridge opened are its own — always accessible, and the
			// reason enforcement never blocks the agent from working.
			if (!tab || tab.bridgeOwned) continue;
			if (available && info.url && urls.has(normalizeUrl(info.url))) continue;
			// With no sharing signal (Copilot/chat off, or VS Code < 1.131) the
			// user has no way to *grant* access to their own tabs — there is no
			// share button to press. Failing open would hand over everything
			// they never consented to; failing fully closed would be useless.
			// So the user's tabs stay off-limits and the agent works in tabs it
			// opens itself, which needs no consent to express.
			await this.cdp.revokeTab(
				info.tabId,
				available
					? 'page no longer shared'
					: 'sharing cannot be expressed in this VS Code (chat disabled or < 1.131), so only bridge-opened tabs are accessible',
			);
		}
	}

	/**
	 * Report whether unsharing actually revokes access, without overstating it.
	 * Enforcement is opt-in *and* depends on a signal that may be absent, so
	 * "enforced" means both conditions hold — never just the setting.
	 */
	private async sharingStatus(): Promise<Record<string, unknown>> {
		const enabled = isEnforcementEnabled();
		if (!enabled) {
			return {
				enforced: false,
				mode: 'off',
				note: 'Unsharing a page in VS Code does NOT detach this bridge. Sharing is Copilot\'s consent gate for its own tools; this bridge attaches over CDP to every browser tab in the window, and the proposed API exposes no sharing state. To actually revoke access: close the tab, or stop the bridge (Browser Bridge: Stop). Set browserBridge.enforceSharing to make unsharing revoke.',
			};
		}
		const { available } = await sharedUrls(this.log);
		return available
			? {
				enforced: true,
				mode: 'enforcing',
				note: 'browserBridge.enforceSharing is on: the bridge drives only tabs it opened itself plus pages VS Code reports as shared. Unsharing detaches within ~2s and later calls on that tabId fail. Matching is by URL, so two tabs on the same URL are indistinguishable.',
			}
			: {
				enforced: true,
				mode: 'bridge-owned-only',
				note: 'browserBridge.enforceSharing is on, but sharing cannot be expressed in this VS Code (needs 1.131+ and chat enabled) — there is no share button to press. The bridge therefore drives ONLY tabs it opened itself; the user\'s own tabs are not accessible and cannot be granted. Agents work normally here: browser_tab_open / browser_navigate create bridge-owned tabs. Enable chat if you need to grant access to your existing tabs.',
			};
	}

	/**
	 * Run enforcement, then the handler. For routes that take no
	 * tab-requiring middleware but still act on, close, or read from a
	 * specific tab — every one of those was a way around the guard.
	 */
	private guarded(
		handler: (req: express.Request, res: express.Response) => void | Promise<void>,
	): (req: express.Request, res: express.Response) => void {
		return (req, res) => {
			this.enforceSharing()
				.catch(err => this.log.appendLine(`[Bridge] Sharing enforcement failed: ${err}`))
				.then(() => handler(req, res))
				.catch(err => res.json({ ok: false, error: String(err instanceof Error ? err.message : err) }));
		};
	}

	/** Resolve the target tab for a request (query `?tabId=` or body `tabId`). */
	private resolveTab(req: express.Request): { tab?: CDPTab; error?: string } {
		const tabId = (req.query.tabId as string | undefined) ?? (req.body?.tabId as string | undefined);
		const tab = this.cdp.getTab(tabId);
		if (!tab) {
			// Distinguish "revoked" from "never existed": an agent holding a
			// tabId from before an unshare needs to know its access was
			// withdrawn, not that it mistyped an id.
			const revoked = tabId ? this.cdp.revokedReason(tabId) : undefined;
			if (revoked) {
				return { error: `Tab ${tabId} is no longer accessible: ${revoked}. The user unshared this page; ask them to share it again if you still need it.` };
			}
			return { error: tabId ? `No tab with id ${tabId}` : 'No active tab. Use browser_tab_open first.' };
		}
		return { tab };
	}

	/**
	 * Annotate VS Code-reported pages with the bridge tab serving the same URL,
	 * so an agent can tell which discovered pages it can already drive. Matched
	 * on normalized URL because page ids and tab ids come from different
	 * namespaces and share no identifier.
	 */
	private linkToTabs(pages: DiscoveredPage[]): DiscoveredPage[] {
		const byUrl = new Map<string, string>();
		for (const tab of this.cdp.list()) {
			if (tab.url) byUrl.set(normalizeUrl(tab.url), tab.tabId);
		}
		return pages.map(page => {
			const tabId = page.url ? byUrl.get(normalizeUrl(page.url)) : undefined;
			return tabId ? { ...page, attachedTabId: tabId } : page;
		});
	}

	private setupRoutes(): void {
		const existingTab = this.requireExistingTab();
		const anyTabLazyNavigate = this.requireAnyTab(req => req.body?.url as string | undefined);

		// Health / diagnostic
		this.app.get('/status', async (_req, res) => {
			// Report what this build can actually do *before* a tool has to find
			// out by failing, and surface pages that exist but aren't attached —
			// otherwise every field reads "nothing to act on" while a real,
			// reachable page is sitting there.
			const proposedApi = hasProposedBrowserApi();
			let attachablePages = 0;
			if (isDiscoveryEnabled() && isDiscoveryAvailable()) {
				try {
					const discovery = await discoverPages(this.log);
					attachablePages = discovery.pages.length;
				} catch {
					// Discovery is advisory; never let it break /status.
				}
			}
			res.json({
				ok: true,
				data: {
					cdp: this.cdp.state,
					server: true,
					// Degradation used to be silent: the bridge fell back to the
					// debug-session path and every field still read "fine", so
					// agents diagnosed a misconfiguration as a pile of bugs.
					// Say it loudly, at the top level, in one obvious place.
					degraded: !proposedApi,
					...(proposedApi ? {} : { warning: DEGRADED_WARNING }),
					capabilities: {
						browserProposal: proposedApi,
						degraded: !proposedApi,
						tabOpen: proposedApi,
						attachExistingPages: proposedApi,
						multiTab: proposedApi,
						reason: proposedApi ? undefined : DEGRADED_WARNING,
					},
					attachablePages,
					// The bridge's access does not come from VS Code's sharing
					// model and cannot be revoked by it: `BrowserTab` exposes no
					// sharing state, so share/unshare is invisible here. Saying
					// so explicitly matters because discovery *does* honour
					// unshare, which makes the system look like it enforces
					// something it does not.
					sharing: await this.sharingStatus(),
					transport: this.cdp.transport,
					activeTabId: this.cdp.activeTabId,
					tabCount: this.cdp.tabCount,
					pageSessionId: this.cdp.pageSessionId,
					children: this.cdp.children,
					consoleBufferSize: this.cdp.console.length,
					networkBufferSize: this.cdp.network.length,
					events: this.cdp.events,
					emulatePath: this.emulatePath,
					lmPageDiscovery: {
						enabled: isDiscoveryEnabled(),
						available: isDiscoveryAvailable(),
					},
				},
			});
		});

		// Tab management
		this.app.get('/tabs', async (_req, res) => {
			// Enforce first: a revoked tab must not be listed, because listing
			// it is how an agent re-acquires a tabId it should no longer have.
			await this.enforceSharing().catch(() => undefined);
			// Backfill titles the websocket path never populates, so tabs don't
			// come back as untitled. Best-effort and bounded to connected tabs.
			await Promise.all(
				this.cdp.list()
					.filter(info => !info.title && info.state === 'connected')
					.map(info => this.cdp.getTab(info.tabId)?.refreshTitle().catch(() => undefined)),
			);
			res.json({ ok: true, data: this.cdp.list() });
		});

		// Integrated browser pages known to VS Code itself, including ones this
		// bridge has not attached to. Requires VS Code 1.131+; degrades to
		// `available: false` with a reason on older builds.
		this.app.get('/pages', async (_req, res) => {
			try {
				const discovery = await discoverPages(this.log);
				res.json({ ok: true, data: { ...discovery, pages: this.linkToTabs(discovery.pages) } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		});

		this.app.post('/tab/open', async (req, res) => {
			try {
				const url = req.body.url;
				const makeActive = req.body.makeActive !== false;
				const beside = req.body.beside === true;
				if (!url) {
					res.json({ ok: false, error: 'Missing url' });
					return;
				}
				const tab = await this.cdp.openTab(url, makeActive, beside);
				res.json({ ok: true, data: { tabId: tab.tabId, url: tab.url, title: tab.title, icon: tab.iconUri } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		});

		this.app.post('/tab/close/:tabId', this.guarded(async (req, res) => {
			try {
				const tabId = String(req.params.tabId);
				await this.cdp.closeTab(tabId);
				res.json({ ok: true, data: { closed: tabId } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		}));

		this.app.post('/tab/activate/:tabId', this.guarded((req, res) => {
			try {
				const tabId = String(req.params.tabId);
				this.cdp.activate(tabId);
				res.json({ ok: true, data: { active: tabId } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		}));

		// Navigation
		this.app.post('/navigate', anyTabLazyNavigate, async (req, res) => {
			try {
				const { url } = req.body;
				if (!url) {
					res.json({ ok: false, error: 'Missing url' });
					return;
				}
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const result = await resolved.tab.send('Page.navigate', { url });
				// Settle the title before answering: on the websocket path nothing
				// else populates it, so a caller reading straight from the response
				// (or a follow-up /tabs) would report a real page as untitled.
				const title = await resolved.tab.refreshTitle();
				res.json({ ok: true, data: { ...(result as object), tabId: resolved.tab.tabId, url: resolved.tab.url, title } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Eval
		this.app.post('/eval', existingTab, async (req, res) => {
			try {
				const { expression } = req.body;
				if (!expression) {
					res.json({ ok: false, error: 'Missing expression' });
					return;
				}
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const result = await resolved.tab.send('Runtime.evaluate', {
					expression,
					returnByValue: true,
					awaitPromise: true,
				}) as { result: { value?: unknown; description?: string }; exceptionDetails?: unknown };
				if (result.exceptionDetails) {
					res.json({ ok: false, error: result.result.description ?? 'Evaluation error' });
					return;
				}
				res.json({ ok: true, data: result.result.value });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Click
		this.app.post('/click', existingTab, async (req, res) => {
			try {
				const { selector } = req.body;
				if (!selector) {
					res.json({ ok: false, error: 'Missing selector' });
					return;
				}
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const selectorJson = JSON.stringify(selector);
				const result = await resolved.tab.send('Runtime.evaluate', {
					expression: `(() => {
						const sel = ${selectorJson};
						const el = document.querySelector(sel);
						if (!el) return { error: 'Element not found: ' + sel };
						el.click();
						return { clicked: true };
					})()`,
					returnByValue: true,
					awaitPromise: true,
				}) as { result: { value?: { error?: string; clicked?: boolean } } };
				const val = result.result.value;
				if (val?.error) {
					res.json({ ok: false, error: val.error });
					return;
				}
				res.json({ ok: true, data: val });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Type
		this.app.post('/type', existingTab, async (req, res) => {
			try {
				const { selector, text, submit } = req.body;
				if (!selector || text === undefined) {
					res.json({ ok: false, error: 'Missing selector or text' });
					return;
				}
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const selectorJson = JSON.stringify(selector);
				const focusResult = await resolved.tab.send('Runtime.evaluate', {
					expression: `(() => {
						const sel = ${selectorJson};
						const el = document.querySelector(sel);
						if (!el) return { error: 'Element not found: ' + sel };
						el.focus();
						return { focused: true };
					})()`,
					returnByValue: true,
					awaitPromise: true,
				}) as { result: { value?: { error?: string } } };
				if (focusResult.result.value?.error) {
					res.json({ ok: false, error: focusResult.result.value.error });
					return;
				}
				await resolved.tab.send('Input.insertText', { text });
				if (submit) {
					const enterKey = {
						key: 'Enter',
						code: 'Enter',
						windowsVirtualKeyCode: 13,
						nativeVirtualKeyCode: 13,
					};
					await resolved.tab.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...enterKey });
					await resolved.tab.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enterKey });
				}
				res.json({ ok: true, data: { typed: text.length, submitted: Boolean(submit) } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Scroll
		this.app.post('/scroll', existingTab, async (req, res) => {
			try {
				const deltaX = Number(req.body.deltaX) || 0;
				const deltaY = Number(req.body.deltaY) || 0;
				const { selector } = req.body;
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				if (selector) {
					await resolved.tab.send('Runtime.evaluate', {
						expression: `document.querySelector(${JSON.stringify(selector)})?.scrollBy(${deltaX}, ${deltaY})`,
						returnByValue: true,
					});
				} else {
					await resolved.tab.send('Runtime.evaluate', {
						expression: `window.scrollBy(${deltaX}, ${deltaY})`,
						returnByValue: true,
					});
				}
				res.json({ ok: true, data: { scrolled: true } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Screenshot. `fullPage=true` captures the whole scrollable page
		// (`captureBeyondViewport`); default is viewport-only. `waitMs`
		// sleeps before the capture — needed when the page is mid-CSS-
		// transition (theme flip, view swap), where `className` changes
		// synchronously but paint lags by the transition duration.
		// Numeric colour sampling. In-page readback of a WebGL canvas returns
		// black unless the context was created with `preserveDrawingBuffer`,
		// because the drawing buffer is cleared once the frame is composited.
		// A screenshot captures the composited output instead, so sampling it
		// server-side gives a real value — and an assertable number rather than
		// an image the caller has to look at.
		this.app.post('/pixel', existingTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const tab = resolved.tab;

				const points: Array<{ x: number; y: number; from?: string }> = [];
				if (Array.isArray(req.body?.points)) {
					for (const raw of req.body.points) {
						const x = Number(raw?.x);
						const y = Number(raw?.y);
						// NaN/Infinity would reach Page.captureScreenshot as a clip
						// value and fail obscurely inside CDP; reject it here.
						if (!Number.isFinite(x) || !Number.isFinite(y)) {
							res.json({ ok: false, error: `Invalid point ${JSON.stringify(raw)}: x and y must be finite numbers.` });
							return;
						}
						points.push({ x, y });
					}
				}

				// A selector is usually what the caller actually means: sample the
				// centre of this element. Page coordinates, so scroll is included.
				if (req.body?.selector) {
					const probe = await tab.send('Runtime.evaluate', {
						expression: `(() => {
							const el = document.querySelector(${JSON.stringify(req.body.selector)});
							if (!el) return null;
							const r = el.getBoundingClientRect();
							if (!r.width || !r.height) return { empty: true };
							return { x: r.left + window.scrollX + r.width / 2, y: r.top + window.scrollY + r.height / 2 };
						})()`,
						returnByValue: true,
					}) as { result?: { value?: { x: number; y: number; empty?: boolean } | null } };
					const value = probe?.result?.value;
					if (!value) { res.json({ ok: false, error: `No element matches selector: ${req.body.selector}` }); return; }
					if (value.empty) { res.json({ ok: false, error: `Element has zero size: ${req.body.selector}` }); return; }
					points.push({ x: value.x, y: value.y, from: req.body.selector });
				}

				if (!points.length) { res.json({ ok: false, error: 'Provide `selector`, or `points` as [{x, y}] in page coordinates.' }); return; }
				if (points.length > 32) { res.json({ ok: false, error: 'At most 32 points per call.' }); return; }

				const waitMs = Math.min(10000, Math.max(0, Number(req.body?.waitMs) || 0));
				if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));

				// One 1x1 capture per point rather than one big capture plus
				// coordinate maths: it sidesteps device-pixel-ratio scaling
				// entirely, since the clip is expressed in CSS pixels.
				const samples = [];
				for (const point of points) {
					const shot = await tab.send('Page.captureScreenshot', {
						format: 'png',
						clip: { x: point.x, y: point.y, width: 1, height: 1, scale: 1 },
					}) as { data: string };
					const image = decodePng(Buffer.from(shot.data, 'base64'));
					samples.push({ ...pixelAt(image, 0, 0), x: point.x, y: point.y, ...(point.from ? { selector: point.from } : {}) });
				}
				res.json({
					ok: true,
					data: {
						samples,
						note: points.length > 1
							? 'Each point is captured separately, so an animating page may return values from different frames.'
							: undefined,
					},
				});
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		});

		this.app.get('/screenshot', existingTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const fullPage = req.query.fullPage === 'true';
				const waitMs = Math.min(10000, Math.max(0, Number(req.query.waitMs) || 0));
				if (waitMs > 0) {
					await new Promise(resolve => setTimeout(resolve, waitMs));
				}
				const result = await resolved.tab.send('Page.captureScreenshot', {
					format: 'png',
					captureBeyondViewport: fullPage,
				}) as { data: string };
				res.json({ ok: true, data: result.data });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Emulate device metrics + (when mobile) touch + optional UA.
		// Sticky until cleared with `{reset:true}` — leaking emulation
		// between tool calls is a frequent "why does my screenshot look
		// wrong" source. `mobile:true` also flips touch on so
		// `(hover:none)` / `(pointer:coarse)` media queries fire;
		// without that, mobile sites render their desktop fallback even
		// at iPhone dimensions.
		//
		// Two-path strategy: try the modern `Emulation.setDeviceMetrics-
		// Override` first, then verify it stuck by checking
		// `window.innerWidth`. If VS Code's `BrowserTab` surface silently
		// drops the Emulation width/height (which it has historically
		// done — only `mobile` survives the filter), fall back to the
		// deprecated `Page.setDeviceMetricsOverride`. The Page.* path
		// isn't filtered today but is gone from upstream Chromium, so
		// preferring Emulation.* makes the bridge forward-compatible
		// with whichever side gets fixed first. `/status` exposes which
		// path won most recently for debugging. `Emulation.clearDevice-
		// MetricsOverride` clears either override, so reset is one call.
		this.app.post('/emulate', existingTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const { reset, width, height, deviceScaleFactor, mobile, userAgent } = req.body;
				if (reset) {
					await resolved.tab.send('Emulation.clearDeviceMetricsOverride');
					await resolved.tab.send('Emulation.setTouchEmulationEnabled', { enabled: false });
					await resolved.tab.send('Emulation.setUserAgentOverride', { userAgent: '' });
					res.json({ ok: true, data: { reset: true } });
					return;
				}
				if (typeof width !== 'number' || typeof height !== 'number') {
					res.json({ ok: false, error: 'Missing width and height (or pass {reset:true} to clear)' });
					return;
				}
				const isMobile = mobile === true;
				const dpr = typeof deviceScaleFactor === 'number' ? deviceScaleFactor : 1;
				const params = { width, height, deviceScaleFactor: dpr, mobile: isMobile };

				let path: 'emulation' | 'page' = 'emulation';
				try {
					await resolved.tab.send('Emulation.setDeviceMetricsOverride', params);
				} catch {
					path = 'page';
				}
				if (path === 'emulation') {
					const probe = await resolved.tab.send('Runtime.evaluate', {
						expression: 'window.innerWidth',
						returnByValue: true,
					}) as { result: { value: number } };
					if (probe.result.value !== width) {
						path = 'page';
					}
				}
				if (path === 'page') {
					await resolved.tab.send('Page.setDeviceMetricsOverride', params);
				}
				this.emulatePath = path;

				await resolved.tab.send('Emulation.setTouchEmulationEnabled', { enabled: isMobile });
				if (typeof userAgent === 'string' && userAgent.length > 0) {
					await resolved.tab.send('Emulation.setUserAgentOverride', { userAgent });
				}
				res.json({ ok: true, data: { width, height, deviceScaleFactor: dpr, mobile: isMobile, userAgent: userAgent ?? null, path } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Scroll-and-capture one viewport-height slice. Returns metadata
		// always, image only when `slice` is provided. Designed for AI
		// consumers of tall pages: Chromium's single-PNG axis cap
		// (~16384 px) makes `fullPage` capture fail on huge docs, and
		// compressing a 60k-px-tall image to thumbnail loses the detail
		// the model needs anyway. The AI-friendlier flow is (1) call
		// with no slice to learn the page shape, (2) request specific
		// slices by index. `slice: 0` is the top, `slice: -1` is the
		// last (Pythonic negative indexing). Out-of-range clamps.
		// Pair with `browser_emulate` first to anchor the viewport at a
		// real desktop/mobile size — slicing the editor pane's natural
		// width gives meaningless results.
		this.app.get('/screenshot-slice', existingTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const dims = await resolved.tab.send('Runtime.evaluate', {
					expression: '({scrollHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight})',
					returnByValue: true,
				}) as { result: { value: { scrollHeight: number; viewportHeight: number } } };
				const { scrollHeight, viewportHeight } = dims.result.value;
				const totalSlices = Math.max(1, Math.ceil(scrollHeight / viewportHeight));

				const sliceParam = req.query.slice;
				if (sliceParam === undefined || sliceParam === '') {
					res.json({ ok: true, data: { totalSlices, scrollHeight, viewportHeight, slice: null } });
					return;
				}
				const rawSlice = Number(sliceParam);
				if (!Number.isFinite(rawSlice)) {
					res.json({ ok: false, error: 'slice must be an integer (negative counts from end)' });
					return;
				}
				let slice = Math.trunc(rawSlice);
				if (slice < 0) slice = totalSlices + slice;
				slice = Math.max(0, Math.min(totalSlices - 1, slice));

				const prev = await resolved.tab.send('Runtime.evaluate', {
					expression: '({x: window.scrollX, y: window.scrollY})',
					returnByValue: true,
				}) as { result: { value: { x: number; y: number } } };
				const { x: prevX, y: prevY } = prev.result.value;

				const targetY = slice * viewportHeight;
				try {
					await resolved.tab.send('Runtime.evaluate', {
						expression: `window.scrollTo(0, ${targetY}); new Promise(r => setTimeout(r, 200))`,
						returnByValue: true,
						awaitPromise: true,
					});
					const shot = await resolved.tab.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
					res.json({ ok: true, data: { totalSlices, scrollHeight, viewportHeight, slice, image: shot.data } });
				} finally {
					await resolved.tab.send('Runtime.evaluate', {
						expression: `window.scrollTo(${prevX}, ${prevY})`,
						returnByValue: true,
					}).catch(() => {});
				}
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Markdown extraction. Pure-JS DOM walker injected into the page;
		// no Readability/Turndown, no deps. Maps headings → `#`, links →
		// `[text](url)`, code/pre → backtick markup, lists → `-` / `1.`,
		// blockquotes → `>`. Skips script/style/svg/iframe/button.
		//
		// Two non-obvious refinements over a naive walker, both forced by
		// real-world docs sites (Apple Developer in particular):
		//
		//  1. *Link-text trim.* Apple's HTML often contains `<a> View </a>`
		//     with whitespace inside the anchor. A naive walker emits
		//     `[ View ](...)`, which renders with literal brackets-with-
		//     spaces in most markdown viewers. Trimming the inner text
		//     before bracketing produces clean `[View](...)`.
		//
		//  2. *Inline-sibling separator.* When a parent contains adjacent
		//     inline elements with no whitespace between them in the
		//     source — Apple's platform availability is the canonical
		//     case: `<span>iOS 13.0+</span><span>iPadOS 13.0+</span>` —
		//     concatenating their text gives the run-on "iOS 13.0+iPadOS
		//     13.0+". When walking children, if two adjacent kids are
		//     both inline elements and the join would mash non-whitespace
		//     against non-whitespace, insert a single space. A boundary
		//     character on either side (punctuation, whitespace) opts out
		//     so we don't break `<strong>word</strong>.`.
		this.app.get('/markdown', existingTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const selector = (req.query.selector as string | undefined) || 'main';
				const expression = `(() => {
					const root = document.querySelector(${JSON.stringify(selector)}) || document.body;
					const SKIP = new Set(['script','style','noscript','svg','iframe','button']);
					const INLINE = new Set(['span','a','strong','b','em','i','code','small','sub','sup','mark']);
					function walk(n) {
						if (n.nodeType === 3) return n.textContent.replace(/\\s+/g, ' ');
						if (n.nodeType !== 1) return '';
						const tag = n.tagName.toLowerCase();
						if (SKIP.has(tag)) return '';
						let kids = '';
						let prev = null;
						for (const c of n.childNodes) {
							const p = walk(c);
							if (!p) continue;
							if (kids && prev && prev.nodeType === 1 && INLINE.has(prev.tagName.toLowerCase())
									&& c.nodeType === 1 && INLINE.has(c.tagName.toLowerCase())) {
								const lc = kids[kids.length - 1], fc = p[0];
								if (/\\S/.test(lc) && /\\S/.test(fc)) kids += ' ';
							}
							kids += p;
							prev = c;
						}
						switch (tag) {
							case 'h1': return '\\n\\n# ' + kids.trim() + '\\n\\n';
							case 'h2': return '\\n\\n## ' + kids.trim() + '\\n\\n';
							case 'h3': return '\\n\\n### ' + kids.trim() + '\\n\\n';
							case 'h4': return '\\n\\n#### ' + kids.trim() + '\\n\\n';
							case 'h5': return '\\n\\n##### ' + kids.trim() + '\\n\\n';
							case 'h6': return '\\n\\n###### ' + kids.trim() + '\\n\\n';
							case 'p': return '\\n\\n' + kids.trim() + '\\n\\n';
							case 'br': return '\\n';
							case 'hr': return '\\n\\n---\\n\\n';
							case 'strong': case 'b': return '**' + kids + '**';
							case 'em': case 'i': return '*' + kids + '*';
							case 'code':
								if (n.parentElement && n.parentElement.tagName === 'PRE') return kids;
								return '\`' + kids + '\`';
							case 'pre': return '\\n\\n\`\`\`\\n' + n.textContent.trim() + '\\n\`\`\`\\n\\n';
							case 'a': { const h = n.getAttribute('href'); const t = kids.trim(); return h ? '[' + t + '](' + h + ')' : t; }
							case 'img': { const a = n.getAttribute('alt') || ''; const s = n.getAttribute('src') || ''; return s ? '![' + a + '](' + s + ')' : ''; }
							case 'li': { const ord = n.parentElement && n.parentElement.tagName === 'OL'; return (ord ? '1. ' : '- ') + kids.trim() + '\\n'; }
							case 'ul': case 'ol': return '\\n' + kids + '\\n';
							case 'blockquote': return '\\n' + kids.split('\\n').map(l => l ? '> ' + l : '').join('\\n') + '\\n\\n';
							default: return kids;
						}
					}
					return walk(root).replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]+$/gm, '').trim();
				})()`;
				const result = await resolved.tab.send('Runtime.evaluate', {
					expression,
					returnByValue: true,
				}) as { result: { value?: string; description?: string }; exceptionDetails?: unknown };
				if (result.exceptionDetails) {
					res.json({ ok: false, error: result.result.description ?? 'Markdown extraction failed' });
					return;
				}
				res.json({ ok: true, data: result.result.value ?? '' });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Accessibility snapshot
		this.app.get('/snapshot', existingTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				// A real SPA produces a six-figure-character full AX tree, which
				// blows the model's token ceiling and costs a round trip. Prune
				// and project by default; `full=true` restores the raw dump.
				const full = req.query.full === 'true';
				const includeIgnored = req.query.includeIgnored === 'true';
				const interactiveOnly = req.query.interactiveOnly === 'true';
				const selector = req.query.selector as string | undefined;
				const limit = Math.max(1, Number(req.query.limit) || 1500);

				let rootId: string | undefined;
				if (selector) {
					const doc = await resolved.tab.send('DOM.getDocument', { depth: -1 }) as { root: { nodeId: number } };
					const found = await resolved.tab.send('DOM.querySelector', {
						nodeId: doc.root.nodeId,
						selector,
					}) as { nodeId: number };
					if (!found?.nodeId) {
						res.json({ ok: false, error: `No element matches selector: ${selector}` });
						return;
					}
					const partial = await resolved.tab.send('Accessibility.getPartialAXTree', {
						nodeId: found.nodeId,
						fetchRelatives: false,
					}) as { nodes: RawAXNode[] };
					rootId = partial.nodes?.[0]?.nodeId;
				}

				const tree = await resolved.tab.send('Accessibility.getFullAXTree') as { nodes: RawAXNode[] };
				let nodes = tree.nodes ?? [];

				if (rootId) nodes = descendantsOf(nodes, rootId);
				if (full) {
					res.json({ ok: true, data: nodes });
					return;
				}

				const projected = projectAXNodes(nodes, { includeIgnored, interactiveOnly });
				const truncated = projected.length > limit;
				res.json({
					ok: true,
					data: {
						nodes: projected.slice(0, limit),
						totalMatched: projected.length,
						totalRaw: nodes.length,
						truncated,
						...(truncated
							? { note: `Showing ${limit} of ${projected.length} nodes. Narrow with selector=, or raise limit=. For specific values prefer /eval.` }
							: {}),
					},
				});
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// DOM
		this.app.get('/dom', existingTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const result = await resolved.tab.send('Runtime.evaluate', {
					expression: 'document.documentElement.outerHTML',
					returnByValue: true,
				}) as { result: { value?: string } };
				res.json({ ok: true, data: result.result.value });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Console — filter by tabId when provided, aggregated otherwise
		this.app.get('/console', this.guarded((req, res) => {
			const limit = parseInt(req.query.limit as string) || 50;
			const tabId = req.query.tabId as string | undefined;
			const entries = tabId ? this.cdp.consoleForTab(tabId) : this.cdp.console;
			res.json({ ok: true, data: entries.slice(-limit) });
		}));

		// Network — filter by tabId when provided, aggregated otherwise
		this.app.get('/network', this.guarded((req, res) => {
			const limit = parseInt(req.query.limit as string) || 50;
			const tabId = req.query.tabId as string | undefined;
			const filter = req.query.filter as string | undefined;
			let entries = tabId ? this.cdp.networkForTab(tabId) : this.cdp.network;
			if (filter) {
				entries = entries.filter(e => e.url.includes(filter));
			}
			res.json({ ok: true, data: entries.slice(-limit) });
		}));

		this.app.post('/network/clear', this.guarded((req, res) => {
			const tabId = req.query.tabId as string | undefined;
			this.cdp.clearNetwork(tabId);
			res.json({ ok: true, data: { cleared: tabId ?? 'all' } });
		}));

		// Download behavior. Replaces the native save dialog with a configured
		// directory so an agent can download files headless. Path scoping to
		// the workspace happens in the MCP layer (browser_download_set);
		// callers hitting this endpoint directly (curl, scripts) pass an
		// absolute path and own the consequences.
		this.app.post('/download/set', existingTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const downloadPath = req.body.path as string | undefined;
				const behavior = (req.body.behavior as string | undefined) ?? 'allow';
				if (!DOWNLOAD_BEHAVIORS.has(behavior as DownloadBehavior)) {
					res.json({ ok: false, error: `Invalid behavior "${behavior}". Expected one of: allow, allowAndName, deny, default` });
					return;
				}
				if (behavior === 'allow' || behavior === 'allowAndName') {
					if (!downloadPath) {
						res.json({ ok: false, error: 'path is required for behavior allow/allowAndName' });
						return;
					}
					await fs.promises.mkdir(downloadPath, { recursive: true });
				}
				await resolved.tab.setDownloadBehavior(downloadPath ?? '', behavior as DownloadBehavior);
				res.json({ ok: true, data: { path: (behavior === 'allow' || behavior === 'allowAndName') ? downloadPath : null, behavior } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		});

		this.app.get('/downloads', this.guarded((req, res) => {
			const limit = parseInt(req.query.limit as string) || 20;
			const tabId = req.query.tabId as string | undefined;
			const entries = tabId ? this.cdp.downloadsForTab(tabId) : this.cdp.downloads;
			res.json({ ok: true, data: entries.slice(-limit) });
		}));

		// URL
		this.app.get('/url', existingTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const result = await resolved.tab.send('Runtime.evaluate', {
					expression: 'window.location.href',
					returnByValue: true,
				}) as { result: { value?: string } };
				res.json({ ok: true, data: result.result.value });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Global error handler
		this.app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
			this.log.appendLine(`[HTTP] Unhandled error: ${err.message}`);
			res.status(500).json({ ok: false, error: 'Internal server error' });
		});
	}

	get port(): number | null {
		const addr = this.server?.address();
		return addr && typeof addr === 'object' ? addr.port : null;
	}

	/**
	 * Listen on a unix socket (POSIX) or named pipe (Windows) instead of a TCP
	 * port. Nothing is bound to a network interface, so there is no port to
	 * scan and no chance of colliding with another service; access control
	 * becomes filesystem permissions (0600) rather than "we bound to loopback".
	 *
	 * Viable because the MCP server and the extension host must already share a
	 * filesystem — instance discovery is a file under `~`. Where that holds
	 * (VS Code local, WSL remote, dev containers) the pipe works; where it does
	 * not, discovery never worked either and the caller falls back to TCP.
	 */
	async startOnSocket(socketPath: string): Promise<string> {
		// A crashed extension host leaves the socket file behind, and bind()
		// fails on an existing path. Only remove it if nothing is listening.
		if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
			const live = await this.probeSocket(socketPath);
			if (live) throw new Error(`Socket already in use: ${socketPath}`);
			try { fs.unlinkSync(socketPath); } catch { /* raced with another cleanup */ }
		}
		await new Promise<void>((resolve, reject) => {
			const server = this.app.listen(socketPath);
			server.once('listening', () => {
				this.server = server;
				resolve();
			});
			server.once('error', err => { server.close(); reject(err); });
		});
		// Defence in depth: the owner-only parent directory is what actually
		// prevents another local user reaching this, since there is an
		// unavoidable window between bind and chmod. Named pipes are not
		// filesystem objects and have no mode to set.
		if (process.platform !== 'win32') {
			try { fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ }
		}
		this.socketPath = socketPath;
		this.log.appendLine(`[HTTP] Server listening on ${socketPath} (no TCP port)`);
		return socketPath;
	}

	/** True when something is actively accepting on this socket path. */
	private probeSocket(socketPath: string): Promise<boolean> {
		return new Promise(resolve => {
			const socket = net.connect(socketPath);
			const timer = setTimeout(() => done(false), 500);
			const done = (live: boolean) => { clearTimeout(timer); socket.destroy(); resolve(live); };
			socket.once('connect', () => done(true));
			socket.once('error', () => done(false));
		});
	}

	async start(preferredPort: number, maxRetries = 20): Promise<number> {
		for (let attempt = 0; attempt < maxRetries; attempt++) {
			const port = preferredPort + attempt;
			try {
				await this.listen(port);
				return port;
			} catch (err: unknown) {
				if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EADDRINUSE') {
					this.log.appendLine(`[HTTP] Port ${port} in use, trying next...`);
					continue;
				}
				throw err;
			}
		}
		throw new Error(`No free port found after ${maxRetries} attempts starting from ${preferredPort}`);
	}

	private listen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = this.app.listen(port, '127.0.0.1');
			server.once('listening', () => {
				this.server = server;
				this.log.appendLine(`[HTTP] Server listening on http://127.0.0.1:${port}`);
				resolve();
			});
			server.once('error', (err) => {
				server.close();
				reject(err);
			});
		});
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			if (this.server) {
				this.server.closeAllConnections();
				this.server.close(() => resolve());
				this.server = null;
			} else {
				resolve();
			}
		});
	}
}
