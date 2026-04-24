import * as http from 'http';
import express from 'express';
import type { CDPManager } from './cdp';
import type { CDPTab } from './cdp-tab';
import type * as vscode from 'vscode';

export class BridgeServer {
	private app: express.Application;
	private server: http.Server | null = null;
	private cdp: CDPManager;
	private log: vscode.OutputChannel;
	private ensureBrowser: ((url?: string) => Promise<void>) | null = null;

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

	/** Resolve the target tab for a request (query `?tabId=` or body `tabId`). */
	private resolveTab(req: express.Request): { tab?: CDPTab; error?: string } {
		const tabId = (req.query.tabId as string | undefined) ?? (req.body?.tabId as string | undefined);
		const tab = this.cdp.getTab(tabId);
		if (!tab) {
			return { error: tabId ? `No tab with id ${tabId}` : 'No active tab. Use browser_tab_open first.' };
		}
		return { tab };
	}

	private setupRoutes(): void {
		const anyTab = this.requireAnyTab();
		const anyTabLazyNavigate = this.requireAnyTab(req => req.body?.url as string | undefined);

		// Health / diagnostic
		this.app.get('/status', (_req, res) => {
			res.json({
				ok: true,
				data: {
					cdp: this.cdp.state,
					server: true,
					transport: this.cdp.transport,
					activeTabId: this.cdp.activeTabId,
					tabCount: this.cdp.tabCount,
					pageSessionId: this.cdp.pageSessionId,
					children: this.cdp.children,
					consoleBufferSize: this.cdp.console.length,
					networkBufferSize: this.cdp.network.length,
					events: this.cdp.events,
				},
			});
		});

		// Tab management
		this.app.get('/tabs', (_req, res) => {
			res.json({ ok: true, data: this.cdp.list() });
		});

		this.app.post('/tab/open', async (req, res) => {
			try {
				const url = req.body.url;
				const makeActive = req.body.makeActive !== false;
				if (!url) {
					res.json({ ok: false, error: 'Missing url' });
					return;
				}
				const tab = await this.cdp.openTab(url, makeActive);
				res.json({ ok: true, data: { tabId: tab.tabId, url: tab.url, title: tab.title } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		});

		this.app.post('/tab/close/:tabId', async (req, res) => {
			try {
				await this.cdp.closeTab(req.params.tabId);
				res.json({ ok: true, data: { closed: req.params.tabId } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		});

		this.app.post('/tab/activate/:tabId', (req, res) => {
			try {
				this.cdp.activate(req.params.tabId);
				res.json({ ok: true, data: { active: req.params.tabId } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		});

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
				res.json({ ok: true, data: result });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Eval
		this.app.post('/eval', anyTab, async (req, res) => {
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
		this.app.post('/click', anyTab, async (req, res) => {
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
		this.app.post('/type', anyTab, async (req, res) => {
			try {
				const { selector, text } = req.body;
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
				res.json({ ok: true, data: { typed: text.length } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Scroll
		this.app.post('/scroll', anyTab, async (req, res) => {
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
		this.app.get('/screenshot', anyTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const fullPage = req.query.fullPage === 'true';
				const waitMs = Number(req.query.waitMs);
				if (Number.isFinite(waitMs) && waitMs > 0) {
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
		// Uses the deprecated `Page.setDeviceMetricsOverride` rather
		// than the modern `Emulation.setDeviceMetricsOverride`. In a
		// normal Chrome they're equivalent, but VS Code's `BrowserTab`
		// surface silently drops the Emulation call's
		// width/height/deviceScaleFactor (only the mobile flag sticks).
		// The deprecated `Page.*` path isn't filtered and is the only
		// way to get actual viewport + DPR overrides in the integrated
		// browser pane. `Emulation.clearDeviceMetricsOverride` clears
		// the Page.* override too, so reset stays one call.
		this.app.post('/emulate', anyTab, async (req, res) => {
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
				await resolved.tab.send('Page.setDeviceMetricsOverride', {
					width,
					height,
					deviceScaleFactor: typeof deviceScaleFactor === 'number' ? deviceScaleFactor : 1,
					mobile: isMobile,
				});
				await resolved.tab.send('Emulation.setTouchEmulationEnabled', { enabled: isMobile });
				if (typeof userAgent === 'string' && userAgent.length > 0) {
					await resolved.tab.send('Emulation.setUserAgentOverride', { userAgent });
				}
				res.json({ ok: true, data: { width, height, deviceScaleFactor: deviceScaleFactor ?? 1, mobile: isMobile, userAgent: userAgent ?? null } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Accessibility snapshot
		this.app.get('/snapshot', anyTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const result = await resolved.tab.send('Accessibility.getFullAXTree') as { nodes: unknown[] };
				res.json({ ok: true, data: result.nodes });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// DOM
		this.app.get('/dom', anyTab, async (req, res) => {
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
		this.app.get('/console', (req, res) => {
			const limit = parseInt(req.query.limit as string) || 50;
			const tabId = req.query.tabId as string | undefined;
			const entries = tabId ? this.cdp.consoleForTab(tabId) : this.cdp.console;
			res.json({ ok: true, data: entries.slice(-limit) });
		});

		// Network — filter by tabId when provided, aggregated otherwise
		this.app.get('/network', (req, res) => {
			const limit = parseInt(req.query.limit as string) || 50;
			const tabId = req.query.tabId as string | undefined;
			const filter = req.query.filter as string | undefined;
			let entries = tabId ? this.cdp.networkForTab(tabId) : this.cdp.network;
			if (filter) {
				entries = entries.filter(e => e.url.includes(filter));
			}
			res.json({ ok: true, data: entries.slice(-limit) });
		});

		this.app.post('/network/clear', (req, res) => {
			const tabId = req.query.tabId as string | undefined;
			this.cdp.clearNetwork(tabId);
			res.json({ ok: true, data: { cleared: tabId ?? 'all' } });
		});

		// URL
		this.app.get('/url', anyTab, async (req, res) => {
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
