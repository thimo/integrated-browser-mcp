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
					pageSessionId: this.cdp.pageSessionId,
					children: this.cdp.children,
					consoleBufferSize: this.cdp.console.length,
					networkBufferSize: this.cdp.network.length,
					events: this.cdp.events,
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
				const selectorJson = JSON.stringify(selector);
				const result = await this.cdp.send('Runtime.evaluate', {
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
		this.app.post('/type', cdpGuard, async (req, res) => {
			try {
				const { selector, text } = req.body;
				if (!selector || text === undefined) {
					res.json({ ok: false, error: 'Missing selector or text' });
					return;
				}
				// Focus the element
				const selectorJson = JSON.stringify(selector);
				const focusResult = await this.cdp.send('Runtime.evaluate', {
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
				// Use Input.insertText which dispatches beforeinput/input events
				// that React and other frameworks listen to (keyDown/keyUp alone
				// does not update controlled inputs).
				await this.cdp.send('Input.insertText', { text });
				res.json({ ok: true, data: { typed: text.length } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Scroll
		this.app.post('/scroll', cdpGuard, async (req, res) => {
			try {
				const deltaX = Number(req.body.deltaX) || 0;
				const deltaY = Number(req.body.deltaY) || 0;
				const { selector } = req.body;
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
		this.app.get('/console', (req, res) => {
			const limit = parseInt(req.query.limit as string) || 50;
			const entries = this.cdp.console.slice(-limit);
			res.json({ ok: true, data: entries });
		});

		// Network
		this.app.get('/network', (req, res) => {
			const limit = parseInt(req.query.limit as string) || 50;
			const filter = req.query.filter as string | undefined;
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
				// Close keep-alive connections so close() doesn't hang
				this.server.closeAllConnections();
				this.server.close(() => resolve());
				this.server = null;
			} else {
				resolve();
			}
		});
	}
}
