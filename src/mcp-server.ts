import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const INSTANCES_DIR = path.join(os.homedir(), '.integrated-browser-mcp', 'instances');

interface Instance {
	port: number;
	workspace: string;
	pid: number;
	startedAt: string;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function discoverPort(): number | null {
	const cwd = process.cwd();
	try {
		const files = fs.readdirSync(INSTANCES_DIR).filter(f => f.endsWith('.json'));
		const instances: Instance[] = [];
		for (const file of files) {
			try {
				const data = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), 'utf-8'));
				// Skip instances with dead processes
				if (!isProcessAlive(data.pid)) continue;
				instances.push(data);
			} catch {
				// Skip corrupt files
			}
		}

		// Best match: cwd is inside a registered workspace
		// Sort by workspace length descending so deeper paths match first
		instances.sort((a, b) => b.workspace.length - a.workspace.length);
		for (const inst of instances) {
			if (!inst.workspace) continue;
			// Ensure match is on a path boundary (exact match or followed by separator)
			if (cwd === inst.workspace || cwd.startsWith(inst.workspace + path.sep)) {
				return inst.port;
			}
		}

		// Fallback: return the most recently started instance
		instances.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
		if (instances.length > 0) {
			return instances[0].port;
		}
	} catch {
		// instances dir doesn't exist yet
	}
	return null;
}

let cachedPort: number | null = null;

function getBridgeUrl(): string {
	// Env var override takes priority (for testing / manual config)
	if (process.env.BROWSER_BRIDGE_PORT) {
		return `http://127.0.0.1:${process.env.BROWSER_BRIDGE_PORT}`;
	}
	if (cachedPort) {
		return `http://127.0.0.1:${cachedPort}`;
	}
	const port = discoverPort();
	if (port) {
		cachedPort = port;
		return `http://127.0.0.1:${port}`;
	}
	// Last resort default
	return 'http://127.0.0.1:3788';
}

async function bridgeFetch(urlPath: string, options?: RequestInit): Promise<{ ok: boolean; data?: unknown; error?: string }> {
	try {
		const base = getBridgeUrl();
		const res = await fetch(`${base}${urlPath}`, options);
		return await res.json() as { ok: boolean; data?: unknown; error?: string };
	} catch {
		// Connection failed — invalidate cache and retry discovery once
		if (cachedPort) {
			cachedPort = null;
			const base = getBridgeUrl();
			try {
				const res = await fetch(`${base}${urlPath}`, options);
				return await res.json() as { ok: boolean; data?: unknown; error?: string };
			} catch {
				// Still failing
			}
		}
		return { ok: false, error: 'Integrated Browser MCP is not reachable. Make sure VS Code is running with the extension active.' };
	}
}

async function bridgePost(urlPath: string, body: Record<string, unknown>) {
	return bridgeFetch(urlPath, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

function toMcpResult(result: { ok: boolean; data?: unknown; error?: string }) {
	if (!result.ok) {
		return {
			content: [{ type: 'text' as const, text: `Error: ${result.error}` }],
			isError: true,
		};
	}
	const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
	return { content: [{ type: 'text' as const, text }] };
}

const server = new McpServer({
	name: 'integrated-browser-mcp',
	version: '0.0.1',
});

const tabIdDescription = 'Optional browser tab id (e.g. "tab-ab12cd"). Omit to use the active tab. Use browser_tab_list to see tab ids.';

// Navigate
server.tool(
	'browser_navigate',
	'Navigate the browser to a URL. Replaces the current page of the target tab.',
	{
		url: z.string().describe('The URL to navigate to'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ url, tabId }) => toMcpResult(await bridgePost('/navigate', { url, tabId })),
);

// Eval
server.tool(
	'browser_eval',
	'Execute JavaScript in the browser page. WARNING: runs arbitrary code in whatever page is open.',
	{
		expression: z.string().describe('JavaScript expression to evaluate'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ expression, tabId }) => toMcpResult(await bridgePost('/eval', { expression, tabId })),
);

// Click
server.tool(
	'browser_click',
	'Click an element by CSS selector',
	{
		selector: z.string().describe('CSS selector of the element to click'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ selector, tabId }) => toMcpResult(await bridgePost('/click', { selector, tabId })),
);

// Type
server.tool(
	'browser_type',
	'Type text into an element by CSS selector',
	{
		selector: z.string().describe('CSS selector of the input element'),
		text: z.string().describe('Text to type'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ selector, text, tabId }) => toMcpResult(await bridgePost('/type', { selector, text, tabId })),
);

// Scroll
server.tool(
	'browser_scroll',
	'Scroll the page or a specific element',
	{
		deltaX: z.number().default(0).describe('Horizontal scroll amount in pixels'),
		deltaY: z.number().default(0).describe('Vertical scroll amount in pixels'),
		selector: z.string().optional().describe('CSS selector of element to scroll (default: window)'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ deltaX, deltaY, selector, tabId }) => toMcpResult(await bridgePost('/scroll', { deltaX, deltaY, selector, tabId })),
);

// Screenshot
server.tool(
	'browser_screenshot',
	'Take a screenshot of the current page (returns base64 PNG)',
	{ tabId: z.string().optional().describe(tabIdDescription) },
	async ({ tabId }) => {
		const qs = tabId ? `?tabId=${encodeURIComponent(tabId)}` : '';
		const result = await bridgeFetch(`/screenshot${qs}`);
		if (!result.ok) {
			return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
		}
		return {
			content: [{
				type: 'image' as const,
				data: result.data as string,
				mimeType: 'image/png',
			}],
		};
	},
);

// Snapshot (accessibility tree)
server.tool(
	'browser_snapshot',
	'Get the accessibility tree of the current page (useful for understanding page structure)',
	{ tabId: z.string().optional().describe(tabIdDescription) },
	async ({ tabId }) => {
		const qs = tabId ? `?tabId=${encodeURIComponent(tabId)}` : '';
		return toMcpResult(await bridgeFetch(`/snapshot${qs}`));
	},
);

// DOM
server.tool(
	'browser_dom',
	'Get the full outer HTML of the current page',
	{ tabId: z.string().optional().describe(tabIdDescription) },
	async ({ tabId }) => {
		const qs = tabId ? `?tabId=${encodeURIComponent(tabId)}` : '';
		return toMcpResult(await bridgeFetch(`/dom${qs}`));
	},
);

// Console
server.tool(
	'browser_console',
	'Read buffered console output from the browser. Without tabId, aggregates entries across all tabs (each entry includes its originating tabId).',
	{
		limit: z.number().int().min(1).max(200).default(50).describe('Max entries to return'),
		tabId: z.string().optional().describe('Filter to one tab. Omit to aggregate across all tabs.'),
	},
	async ({ limit, tabId }) => {
		const params = new URLSearchParams({ limit: String(limit) });
		if (tabId) params.set('tabId', tabId);
		return toMcpResult(await bridgeFetch(`/console?${params}`));
	},
);

// Network
server.tool(
	'browser_network',
	'Read buffered network requests from the browser. Without tabId, aggregates across all tabs.',
	{
		limit: z.number().int().min(1).max(200).default(50).describe('Max entries to return'),
		filter: z.string().optional().describe('Filter URLs containing this string'),
		tabId: z.string().optional().describe('Filter to one tab. Omit to aggregate across all tabs.'),
	},
	async ({ limit, filter, tabId }) => {
		const params = new URLSearchParams({ limit: String(limit) });
		if (filter) params.set('filter', filter);
		if (tabId) params.set('tabId', tabId);
		return toMcpResult(await bridgeFetch(`/network?${params}`));
	},
);

// Network clear
server.tool(
	'browser_network_clear',
	'Clear the buffered network request log',
	{ tabId: z.string().optional().describe('Clear one tab only. Omit to clear all tabs.') },
	async ({ tabId }) => {
		const qs = tabId ? `?tabId=${encodeURIComponent(tabId)}` : '';
		return toMcpResult(await bridgeFetch(`/network/clear${qs}`, { method: 'POST' }));
	},
);

// URL
server.tool(
	'browser_url',
	'Get the current page URL',
	{ tabId: z.string().optional().describe(tabIdDescription) },
	async ({ tabId }) => {
		const qs = tabId ? `?tabId=${encodeURIComponent(tabId)}` : '';
		return toMcpResult(await bridgeFetch(`/url${qs}`));
	},
);

// Status
server.tool(
	'browser_status',
	'Check the bridge connection status',
	{},
	async () => toMcpResult(await bridgeFetch('/status')),
);

// Tab management — requires proposed browser API on the extension side.
// On the fallback (debug-session) path, browser_tab_open returns an error;
// browser_tab_list still works (returns the single synthetic tab).

server.tool(
	'browser_tab_open',
	'Open a new browser tab. Requires VS Code to be launched with --enable-proposed-api=thimo.integrated-browser-mcp; otherwise returns an error. Returns the new tabId.',
	{
		url: z.string().describe('Initial URL for the new tab'),
		makeActive: z.boolean().optional().default(true).describe('Make this tab the active (default) target for subsequent tool calls'),
	},
	async ({ url, makeActive }) => toMcpResult(await bridgePost('/tab/open', { url, makeActive })),
);

server.tool(
	'browser_tab_close',
	'Close a browser tab by id.',
	{ tabId: z.string().describe('Tab id from browser_tab_list / browser_tab_open') },
	async ({ tabId }) => toMcpResult(await bridgePost(`/tab/close/${encodeURIComponent(tabId)}`, {})),
);

server.tool(
	'browser_tab_list',
	'List all open browser tabs under the bridge, with id/url/title and which is active.',
	{},
	async () => toMcpResult(await bridgeFetch('/tabs')),
);

server.tool(
	'browser_tab_activate',
	'Set the default target tab for subsequent tool calls that omit tabId. Note: does not move focus in the VS Code UI (not exposed by the proposed API).',
	{ tabId: z.string().describe('Tab id to activate') },
	async ({ tabId }) => toMcpResult(await bridgePost(`/tab/activate/${encodeURIComponent(tabId)}`, {})),
);

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error('MCP server fatal error:', err);
	process.exit(1);
});
