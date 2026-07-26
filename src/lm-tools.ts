import * as vscode from 'vscode';
import type { CDPManager } from './cdp';
import { enforceSharing } from './sharing';

/**
 * Expose the bridge's *distinctive* capabilities to VS Code's own agent via
 * `vscode.lm.registerTool`.
 *
 * VS Code ships browser tools of its own (open/read/screenshot/click/type/…),
 * so duplicating those would only create ambiguity. What its toolset has no
 * equivalent for is buffered **console**, buffered **network**, and **download**
 * events — they need a persistent CDP subscription, and `run_playwright_code`
 * is one-shot so it cannot hold listeners. Those gaps are exactly what this
 * extension already buffers, so contributing them is additive rather than
 * competing, and makes the bridge useful to Copilot as well as to MCP clients.
 *
 * Registration is feature-detected and non-fatal: on a VS Code without the API
 * (or with the contribution unavailable) the extension carries on unchanged.
 */

interface BufferInput {
	tabId?: string;
	limit?: number;
	filter?: string;
}

function textResult(value: unknown): vscode.LanguageModelToolResult {
	const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/** Newest-last slice, matching the HTTP endpoints' semantics. */
function tail<T>(entries: T[], limit?: number): T[] {
	// Coerce and validate: a non-numeric limit ({"limit":"all"}) would make
	// Math.min NaN and slice(-NaN) return the whole buffer — the opposite of a cap.
	const n = Number(limit);
	const size = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : 50;
	return entries.slice(-size);
}

export function registerLanguageModelTools(
	context: vscode.ExtensionContext,
	cdp: () => CDPManager | undefined,
	log: vscode.OutputChannel,
): void {
	const lm = vscode.lm as unknown as { registerTool?: unknown };
	if (typeof lm.registerTool !== 'function') return;

	const register = (
		name: string,
		handler: (input: BufferInput) => unknown,
	): void => {
		try {
			context.subscriptions.push(
				vscode.lm.registerTool<BufferInput>(name, {
					invoke: async options => {
						const manager = cdp();
						if (!manager) {
							return textResult('The Integrated Browser bridge is not running. Start it with "Browser Bridge: Start".');
						}
						// Honour enforceSharing here too: without this, Copilot could
						// keep reading an unshared user tab's buffers/list via these
						// tools while the HTTP layer revoked it.
						await enforceSharing(manager, log).catch(err => log.appendLine(`[LM] enforcement failed: ${err}`));
						return textResult(handler(options.input ?? {}));
					},
				}),
			);
		} catch (err) {
			// A contribution mismatch must not take the extension down.
			log.appendLine(`[LM] Could not register ${name}: ${err}`);
		}
	};

	register('integratedBrowser_console', input => {
		const manager = cdp()!;
		const entries = input.tabId ? manager.consoleForTab(input.tabId) : manager.console;
		return { entries: tail(entries, input.limit), totalBuffered: entries.length };
	});

	register('integratedBrowser_network', input => {
		const manager = cdp()!;
		let entries = input.tabId ? manager.networkForTab(input.tabId) : manager.network;
		if (input.filter) {
			const needle = input.filter.toLowerCase();
			entries = entries.filter(entry => entry.url.toLowerCase().includes(needle));
		}
		return { entries: tail(entries, input.limit), totalBuffered: entries.length };
	});

	register('integratedBrowser_downloads', input => {
		const manager = cdp()!;
		const entries = input.tabId ? manager.downloadsForTab(input.tabId) : manager.downloads;
		return { entries: tail(entries, input.limit), totalBuffered: entries.length };
	});

	register('integratedBrowser_tabs', () => cdp()!.list());

	log.appendLine('[LM] Registered browser buffer tools with VS Code');
}
