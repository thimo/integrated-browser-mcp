import * as http from 'http';
import express from 'express';
import type { CDPConnection } from './cdp';
import type * as vscode from 'vscode';

export class BridgeServer {
	private app: express.Application;
	private server: http.Server | null = null;
	private cdp: CDPConnection;
	private log: vscode.OutputChannel;
	private ensureBrowser: (() => Promise<void>) | null = null;

	constructor(cdp: CDPConnection, log: vscode.OutputChannel) {
		this.cdp = cdp;
		this.log = log;
		this.app = express();
		this.app.use(express.json());
		this.setupRoutes();
	}

	setEnsureBrowser(fn: () => Promise<void>): void {
		this.ensureBrowser = fn;
	}

	private requireCDP(): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
		return (req, res, next) => {
			const run = async () => {
				if (this.cdp.state !== 'connected' && this.ensureBrowser) {
					this.log.appendLine('[HTTP] CDP not connected, launching browser...');
					await this.ensureBrowser();
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

	private setupRoutes(): void {
		const cdpGuard = this.requireCDP();

		// Health
		this.app.get('/status', (_req, res) => {
			res.json({
				ok: true,
				data: {
					cdp: this.cdp.state,
					server: true,
				},
			});
		});

		// Navigation
		this.app.post('/navigate', cdpGuard, async (req, res) => {
			try {
				const { url } = req.body;
				if (!url) {
					res.json({ ok: false, error: 'Missing url' });
					return;
				}
				const result = await this.cdp.send('Page.navigate', { url });
				res.json({ ok: true, data: result });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Eval
		this.app.post('/eval', cdpGuard, async (req, res) => {
			try {
				const { expression } = req.body;
				if (!expression) {
					res.json({ ok: false, error: 'Missing expression' });
					return;
				}
				const result = await this.cdp.send('Runtime.evaluate', {
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
		this.app.post('/click', cdpGuard, async (req, res) => {
			try {
				const { selector } = req.body;
				if (!selector) {
					res.json({ ok: false, error: 'Missing selector' });
					return;
				}
				// Use Runtime.evaluate to find and click the element
				const result = await this.cdp.send('Runtime.evaluate', {
					expression: `(() => {
						const el = document.querySelector(${JSON.stringify(selector)});
						if (!el) return { error: 'Element not found: ${selector}' };
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
		this.app.post('/type', cdpGuard, async (req, res) => {
			try {
				const { selector, text } = req.body;
				if (!selector || text === undefined) {
					res.json({ ok: false, error: 'Missing selector or text' });
					return;
				}
				// Focus the element then dispatch key events
				const focusResult = await this.cdp.send('Runtime.evaluate', {
					expression: `(() => {
						const el = document.querySelector(${JSON.stringify(selector)});
						if (!el) return { error: 'Element not found: ${selector}' };
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
				// Type each character
				for (const char of text) {
					await this.cdp.send('Input.dispatchKeyEvent', {
						type: 'keyDown',
						text: char,
					});
					await this.cdp.send('Input.dispatchKeyEvent', {
						type: 'keyUp',
						text: char,
					});
				}
				res.json({ ok: true, data: { typed: text.length } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Scroll
		this.app.post('/scroll', cdpGuard, async (req, res) => {
			try {
				const { deltaX = 0, deltaY = 0, selector } = req.body;
				if (selector) {
					await this.cdp.send('Runtime.evaluate', {
						expression: `document.querySelector(${JSON.stringify(selector)})?.scrollBy(${deltaX}, ${deltaY})`,
						returnByValue: true,
					});
				} else {
					await this.cdp.send('Runtime.evaluate', {
						expression: `window.scrollBy(${deltaX}, ${deltaY})`,
						returnByValue: true,
					});
				}
				res.json({ ok: true, data: { scrolled: true } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Screenshot
		this.app.get('/screenshot', cdpGuard, async (_req, res) => {
			try {
				const result = await this.cdp.send('Page.captureScreenshot', {
					format: 'png',
				}) as { data: string };
				res.json({ ok: true, data: result.data });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Accessibility snapshot
		this.app.get('/snapshot', cdpGuard, async (_req, res) => {
			try {
				const result = await this.cdp.send('Accessibility.getFullAXTree') as { nodes: unknown[] };
				res.json({ ok: true, data: result.nodes });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// DOM
		this.app.get('/dom', cdpGuard, async (_req, res) => {
			try {
				const result = await this.cdp.send('Runtime.evaluate', {
					expression: 'document.documentElement.outerHTML',
					returnByValue: true,
				}) as { result: { value?: string } };
				res.json({ ok: true, data: result.result.value });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Console
		this.app.get('/console', (_req, res) => {
			const limit = parseInt(_req.query.limit as string) || 50;
			const entries = this.cdp.console.slice(-limit);
			res.json({ ok: true, data: entries });
		});

		// Network
		this.app.get('/network', (_req, res) => {
			const limit = parseInt(_req.query.limit as string) || 50;
			const filter = _req.query.filter as string | undefined;
			let entries = this.cdp.network;
			if (filter) {
				entries = entries.filter(e => e.url.includes(filter));
			}
			res.json({ ok: true, data: entries.slice(-limit) });
		});

		this.app.post('/network/clear', (_req, res) => {
			this.cdp.clearNetwork();
			res.json({ ok: true, data: { cleared: true } });
		});

		// URL
		this.app.get('/url', cdpGuard, async (_req, res) => {
			try {
				const result = await this.cdp.send('Runtime.evaluate', {
					expression: 'window.location.href',
					returnByValue: true,
				}) as { result: { value?: string } };
				res.json({ ok: true, data: result.result.value });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Tabs
		this.app.get('/tabs', cdpGuard, async (_req, res) => {
			try {
				const result = await this.cdp.send('Target.getTargets') as { targetInfos: unknown[] };
				const pages = (result.targetInfos as Array<{ type: string }>).filter(t => t.type === 'page');
				res.json({ ok: true, data: pages });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		this.app.post('/tabs/:id/activate', cdpGuard, async (req, res) => {
			try {
				await this.cdp.send('Target.activateTarget', { targetId: req.params.id });
				res.json({ ok: true, data: { activated: req.params.id } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});
	}

	start(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server = this.app.listen(port, '127.0.0.1', () => {
				this.log.appendLine(`[HTTP] Server listening on http://127.0.0.1:${port}`);
				resolve();
			});
			this.server.on('error', (err) => {
				this.log.appendLine(`[HTTP] Server error: ${err.message}`);
				reject(err);
			});
		});
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			if (this.server) {
				this.server.close(() => resolve());
				this.server = null;
			} else {
				resolve();
			}
		});
	}
}
