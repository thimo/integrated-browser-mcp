import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';

// Replaced at build time by esbuild's `define` (see esbuild.js). Keeps
// package.json as the single source of truth for the version string.
declare const __PKG_VERSION__: string;

const INSTANCES_DIR = path.join(os.homedir(), '.integrated-browser-mcp', 'instances');

interface Instance {
	/** Present when the bridge listens on TCP. */
	port?: number;
	/** Present when the bridge listens on a unix socket / named pipe (preferred). */
	socketPath?: string;
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

function discoverInstance(): Instance | null {
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
				return inst;
			}
		}

		// Fallback: return the most recently started instance
		instances.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
		if (instances.length > 0) {
			return instances[0];
		}
	} catch {
		// instances dir doesn't exist yet
	}
	return null;
}

/**
 * Resolve how to reach the bridge. A unix socket / named pipe is preferred
 * (no listening port at all); TCP remains for instances that could not create
 * one, and for the explicit BROWSER_BRIDGE_PORT override.
 *
 * Re-resolved on every call. Caching was unsafe: VS Code windows shift ports
 * and socket paths on reload, so a cached endpoint can silently route calls to
 * the wrong workspace's bridge. Reading the instances dir costs ~1ms.
 */
function resolveEndpoints(): Array<{ socketPath?: string; port?: number }> {
	// Env override takes priority (manual config / cross-boundary setups where
	// the MCP server and extension host do not share a filesystem). Socket first,
	// matching the socket-preferred policy everywhere else.
	if (process.env.BROWSER_BRIDGE_SOCKET) {
		return [{ socketPath: process.env.BROWSER_BRIDGE_SOCKET }];
	}
	if (process.env.BROWSER_BRIDGE_PORT) {
		const envPort = Number(process.env.BROWSER_BRIDGE_PORT);
		if (Number.isFinite(envPort) && envPort > 0) return [{ port: envPort }];
	}
	const inst = discoverInstance();
	if (inst) {
		// A discovered instance is authoritative: try exactly what it published
		// and let a failure surface. Appending the default port here would let a
		// transient socket error silently reroute to whatever listens on 3788,
		// which in a multi-window setup is a *different workspace's* bridge.
		// Driving the wrong window without knowing is worse than failing.
		const candidates: Array<{ socketPath?: string; port?: number }> = [];
		if (inst.socketPath) candidates.push({ socketPath: inst.socketPath });
		if (inst.port) candidates.push({ port: inst.port });
		if (candidates.length) return candidates;
	}
	// Nothing discovered: fall back to the lowest port the extension binds, which
	// also covers the version-skew case where an older extension is on TCP and
	// never wrote a socket path.
	return [{ port: 3788 }];
}

/**
 * Node's `fetch` cannot address a unix socket without a custom undici
 * dispatcher, so go through `http.request`, which speaks both transports with
 * the same call shape.
 */
const REQUEST_TIMEOUT_MS = 30000;

function requestOne(endpoint: { socketPath?: string; port?: number }, urlPath: string, method: string, body?: string): Promise<string> {
	const options: http.RequestOptions = endpoint.socketPath
		? { socketPath: endpoint.socketPath, path: urlPath, method, timeout: REQUEST_TIMEOUT_MS }
		: { host: '127.0.0.1', port: endpoint.port, path: urlPath, method, timeout: REQUEST_TIMEOUT_MS };
	if (body) {
		options.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
	}
	return new Promise((resolve, reject) => {
		const req = http.request(options, res => {
			let data = '';
			res.setEncoding('utf-8');
			res.on('data', chunk => data += chunk);
			res.on('error', reject); // response socket destroyed mid-body: don't hang
			res.on('end', () => {
				// Surface HTTP errors instead of feeding an error page to JSON.parse.
				const status = res.statusCode ?? 0;
				if (status >= 400) { reject(new Error(`bridge returned HTTP ${status}`)); return; }
				resolve(data);
			});
		});
		// A wedged listener that accepts but never responds must not hang forever.
		req.on('timeout', () => req.destroy(new Error('bridge request timed out')));
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

/** Try each candidate endpoint in order; report the first success. */
async function httpRequest(urlPath: string, method: string, body?: string): Promise<string> {
	let lastError: unknown;
	for (const endpoint of resolveEndpoints()) {
		try {
			return await requestOne(endpoint, urlPath, method, body);
		} catch (err) {
			lastError = err;
		}
	}
	throw lastError ?? new Error('No reachable bridge endpoint');
}

async function bridgeFetch(urlPath: string, init?: { method?: string; body?: string }): Promise<{ ok: boolean; data?: unknown; error?: string }> {
	try {
		const text = await httpRequest(urlPath, init?.method ?? 'GET', init?.body);
		return JSON.parse(text) as { ok: boolean; data?: unknown; error?: string };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Integrated Browser MCP is not reachable (${detail}). Make sure VS Code is running with the extension active.` };
	}
}

async function bridgePost(urlPath: string, body: Record<string, unknown>) {
	return bridgeFetch(urlPath, { method: 'POST', body: JSON.stringify(body) });
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

const SERVER_INSTRUCTIONS = `
This MCP controls the integrated browser that runs inside VS Code itself — the user sees it in an editor tab, not as a separate Chrome window. Multiple tabs can be open at the same time.

Each tab has a stable number in \`browser_tab_list\`'s \`number\` field. When the user says "reload browser 2" or "open that in tab 3", they mean the tab with that number. (The number also appears in the tab title for tabs the bridge opened, per \`integratedBrowserMcp.tabIndicator\`; tabs the user opened are never marked.)

If \`browser_status\` reports \`degraded: true\`, the bridge is on its fallback path and is missing capabilities — read its \`warning\`, and report that to the user rather than diagnosing individual tool failures as bugs.

By default you can only see and drive tabs this bridge opened — tabs the user opened themselves are detached and never appear in \`browser_tab_list\`. That is deliberate, not a fault: opening a page in the integrated browser does not hand it to an agent. If the user asks you to look at a page they already have open, you have two honest answers: open it yourself with \`browser_tab_open\` / \`browser_navigate\` (same browser, same cookies and localhost routing, but a fresh load — so form input, scroll position and post-login state are not carried over), or tell them to enable \`integratedBrowserMcp.allowAllExistingTabs\`, after which their tabs become drivable. \`browser_status\` \`tabAccess\` reports which mode is active.

Two very different setups, so check \`browser_status\` \`capabilities\` before planning:
- **Proposed API granted** (\`capabilities.tabOpen: true\`) — full multi-tab. Open your own tab with \`browser_tab_open\` and pass its \`tabId\` everywhere.
- **Not granted** (the default for a normally-installed build) — \`browser_tab_open\` fails and the bridge cannot attach to a page the user already opened at all, whatever \`allowAllExistingTabs\` says. The only way to get a working tab is \`browser_navigate\` with **no** \`tabId\`: the bridge lazy-launches its own single tab and navigates it. This opens a separate page rather than taking over the user's, so it is not hijacking — but confirm with the user first if a page is already open, since the bridge tab is the only one you can drive.

Target a specific tab by passing \`tabId\` (from \`browser_tab_list\` or \`browser_tab_open\`) to any interaction tool. Omit \`tabId\` to use the active tab.

Pick the cheapest tool for the job:
- \`browser_eval\` with a small JS expression is the fastest way to read specific data (title, element text, form state, URL, computed values). Prefer this over dumping the whole DOM.
- \`browser_snapshot\` returns the accessibility tree — good for understanding page structure before clicking or typing.
- \`browser_dom\` returns the full outer HTML. Heavy; use only when you truly need the complete markup.
- \`browser_screenshot\` captures the page visually. Use only when visual verification actually matters — text-based tools are usually sufficient and much faster.
- \`browser_console\` and \`browser_network\` are already buffered; pass \`tabId\` to filter to one tab. Each entry is timestamped and tagged with a \`target\` field when it originates from a web worker or iframe session.

\`browser_navigate\` replaces the current page of the target tab. If you want the previous page to stay accessible, use \`browser_tab_open\` instead.

\`browser_tab_list\` shows the tabs this bridge drives.

Lazy-launch is the attach mechanism, not just a latency note: if no tab exists, \`browser_navigate\` (with no \`tabId\`) creates and connects one. That is how you go from "no tabs" to a drivable tab when \`browser_tab_open\` is unavailable — so an empty \`browser_tab_list\` does not mean the browser is unreachable. The first such call takes a second longer while the browser starts.
`.trim();

const server = new McpServer({
	name: 'integrated-browser-mcp',
	version: __PKG_VERSION__,
}, {
	instructions: SERVER_INSTRUCTIONS,
});

const tabIdDescription = 'Optional browser tab id (e.g. "tab-ab12cd"). Omit to use the active tab. Use browser_tab_list to see tab ids.';

// Navigate
server.tool(
	'browser_navigate',
	'Navigate the target tab to a URL in the integrated VS Code browser. Replaces the current page — use browser_tab_open to keep the previous page accessible.',
	{
		url: z.string().describe('The URL to navigate to'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ url, tabId }) => toMcpResult(await bridgePost('/navigate', { url, tabId })),
);

// Eval
server.tool(
	'browser_eval',
	'Run a JS expression in the page and return its value. Fastest way to read specific data (title, element text, form values, etc.). Prefer this over browser_dom or browser_screenshot for most read tasks. WARNING: runs arbitrary code — do not pass untrusted input.',
	{
		expression: z.string().describe('JavaScript expression to evaluate. Keep it small; return structured data for the AI to consume. NOTE: reading pixels back from a WebGL canvas (toDataURL/drawImage/readPixels) returns black unless the context set preserveDrawingBuffer — use browser_pixel for on-screen colours.'),
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
		submit: z.boolean().optional().describe('Press Enter after typing (submits forms / search boxes in one call)'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ selector, text, submit, tabId }) => toMcpResult(await bridgePost('/type', { selector, text, submit, tabId })),
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
	'Capture the page as a PNG (returned as an image). Heavy — use only when visual verification matters. For reading data, browser_eval or browser_snapshot is faster. Pass fullPage:true to capture the whole scrollable page (useful for tall single-page sites or layout audits); default is viewport-only. Pass waitMs to sleep before the capture when the page has running CSS transitions (theme flips, view swaps) — 400–600ms covers most Tailwind transition-colors durations.',
	{
		fullPage: z.boolean().optional().describe('Capture the entire scrollable page instead of just the viewport. Default false.'),
		waitMs: z.number().int().min(0).max(10000).optional().describe('Sleep this many milliseconds before capturing. Use when the page has running CSS transitions — className changes are synchronous but paint lags by the transition duration. Default 0.'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ fullPage, waitMs, tabId }) => {
		const params = new URLSearchParams();
		if (fullPage) params.set('fullPage', 'true');
		if (waitMs) params.set('waitMs', String(waitMs));
		if (tabId) params.set('tabId', tabId);
		const qs = params.toString() ? `?${params}` : '';
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

// Emulate
server.tool(
	'browser_emulate',
	'Override device metrics (width, height, deviceScaleFactor, mobile, optional userAgent) on the target tab. Setting `mobile:true` also enables touch emulation so `(hover:none)` / `(pointer:coarse)` media queries fire — without that, mobile sites render their desktop fallback even at iPhone dimensions. The override persists on the tab until cleared with `{reset:true}` — call reset before tests that should see the natural viewport, otherwise prior emulation will leak.',
	{
		width: z.number().int().positive().optional().describe('Viewport width in CSS pixels. Required unless reset is true.'),
		height: z.number().int().positive().optional().describe('Viewport height in CSS pixels. Required unless reset is true.'),
		deviceScaleFactor: z.number().positive().optional().describe('Device pixel ratio (e.g. 2 for Retina, 3 for iPhone Pro). Default 1.'),
		mobile: z.boolean().optional().describe('Emulate a mobile device (enables touch + mobile media queries). Default false.'),
		userAgent: z.string().optional().describe('Override the User-Agent string. Recommended when emulating mobile so server-side UA sniffing matches.'),
		reset: z.boolean().optional().describe('Clear all emulation overrides on this tab. Pass alone — other fields are ignored.'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ width, height, deviceScaleFactor, mobile, userAgent, reset, tabId }) => {
		return toMcpResult(await bridgePost('/emulate', { width, height, deviceScaleFactor, mobile, userAgent, reset, tabId }));
	},
);

// Screenshot slice
server.tool(
	'browser_screenshot_slice',
	'Capture one viewport-height slice of a long page, plus page metadata. Designed for AI consumers of tall pages where a single full-page PNG either fails (Chromium caps single-image axes at ~16384 px) or compresses to an unreadable thumbnail. Call with no `slice` first to learn the shape (returns `totalSlices`, `scrollHeight`, `viewportHeight`, no image), then request specific slices by index. `slice: 0` is the top (header), `slice: -1` is the last slice (footer); negative indices count from the end. Out-of-range indices clamp. Pair with `browser_emulate` first to anchor the viewport at a real desktop/mobile size — slicing the editor pane\'s natural width gives meaningless results. Scroll position is restored after capture, so the tool is stateless from the page\'s perspective.',
	{
		slice: z.number().int().optional().describe('0-indexed slice to capture. Negative counts from the end (-1 = last, -2 = second-to-last). Omit to get metadata only.'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ slice, tabId }) => {
		const params = new URLSearchParams();
		if (typeof slice === 'number') params.set('slice', String(slice));
		if (tabId) params.set('tabId', tabId);
		const qs = params.toString() ? `?${params}` : '';
		const result = await bridgeFetch(`/screenshot-slice${qs}`);
		if (!result.ok) {
			return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
		}
		const data = result.data as { totalSlices: number; scrollHeight: number; viewportHeight: number; slice: number | null; image?: string };
		const summary = data.slice === null
			? `Page has ${data.totalSlices} slice(s) — scrollHeight ${data.scrollHeight}px, viewport ${data.viewportHeight}px. Pass slice:0 for the top, slice:-1 for the footer.`
			: `Slice ${data.slice} of ${data.totalSlices} (y=${data.slice * data.viewportHeight}–${Math.min((data.slice + 1) * data.viewportHeight, data.scrollHeight)}px of ${data.scrollHeight}px total).`;
		const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
			{ type: 'text' as const, text: summary },
		];
		if (data.image) {
			content.push({ type: 'image' as const, data: data.image, mimeType: 'image/png' });
		}
		return { content };
	},
);

// Markdown
server.tool(
	'browser_markdown',
	'Extract page content as markdown. Walks the DOM in-page (~80 lines of pure JS, no Readability/Turndown, no deps). Headings → `#`, links → `[text](url)`, code → backticks, pre → fenced blocks, lists → `-` / `1.`, blockquotes → `>`, images → `![alt](src)`. By default scopes to `<main>` if present, else `<body>`; pass `selector` to scope elsewhere. Useful for letting an agent read a doc page without dumping the entire DOM (browser_dom is much heavier). Lightweight extractor, not Turndown — output may include layout artifacts on heavily designed sites; for those use browser_dom + your own post-processing. Pass `outputPath` to write the markdown to disk and return only `Saved N bytes to <path>` — the path is scoped to the open workspace folder (relative paths resolve against it; absolute paths must live inside it). Useful for bulk archival where the body would otherwise flow through the agent\'s context.',
	{
		selector: z.string().optional().describe('CSS selector to scope extraction to (e.g. "article", "#content"). Default: "main" if present, else body.'),
		outputPath: z.string().optional().describe('Path (absolute or workspace-relative) to write the markdown to. Resolved against the open workspace folder; the resolved path must live inside it. Parent directories are created if missing; existing files are overwritten. When set, the tool returns a short "Saved N bytes to <path>" confirmation instead of the markdown body — keeps the content out of the agent\'s context for archival jobs. Symlinks inside the workspace that escape it are not followed; don\'t enable in workspaces with hostile symlinks.'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ selector, outputPath, tabId }) => {
		const params = new URLSearchParams();
		if (selector) params.set('selector', selector);
		if (tabId) params.set('tabId', tabId);
		const qs = params.toString() ? `?${params}` : '';
		const result = await bridgeFetch(`/markdown${qs}`);
		if (!result.ok) {
			return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
		}
		if (outputPath !== undefined) {
			// Scope outputPath to the bound workspace folder. Relative paths
			// resolve against the workspace; absolute paths must live inside
			// it. Symlinks are not followed — `fs.realpath` per write would
			// add cost for a low-probability case in a workspace the user
			// controls; documented above instead.
			const instance = discoverInstance();
			if (!instance?.workspace) {
				return { content: [{ type: 'text' as const, text: `Error: outputPath requires an open workspace folder` }], isError: true };
			}
			const workspace = instance.workspace;
			const resolved = path.isAbsolute(outputPath)
				? path.resolve(outputPath)
				: path.resolve(workspace, outputPath);
			if (resolved !== workspace && !resolved.startsWith(workspace + path.sep)) {
				return { content: [{ type: 'text' as const, text: `Error: outputPath must be inside the workspace (${workspace}); got ${resolved}` }], isError: true };
			}
			const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
			try {
				await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
				await fs.promises.writeFile(resolved, body, 'utf8');
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: [{ type: 'text' as const, text: `Error: failed to write ${resolved}: ${message}` }], isError: true };
			}
			return { content: [{ type: 'text' as const, text: `Saved ${Buffer.byteLength(body, 'utf8')} bytes to ${resolved}` }] };
		}
		return toMcpResult(result);
	},
);

// Pixel sampling
server.tool(
	'browser_pixel',
	'Read the actual on-screen colour at a point, as numbers. Use this instead of browser_eval + canvas readback: a WebGL canvas created without `preserveDrawingBuffer` has its drawing buffer cleared after compositing, so toDataURL/drawImage/readPixels return solid black regardless of what is displayed. This samples the composited screenshot instead, so it sees what the user sees. Prefer it over browser_screenshot when you want to assert a colour rather than look at one. Returns { samples: [{ hex, r, g, b, a, x, y }] }.',
	{
		selector: z.string().optional().describe('CSS selector; samples the centre of this element. Usually what you want.'),
		points: z.array(z.object({ x: z.number(), y: z.number() })).optional().describe('Explicit page coordinates (CSS pixels, including scroll offset).'),
		waitMs: z.number().optional().describe('Delay before sampling, for in-flight CSS transitions.'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ selector, points, waitMs, tabId }) => toMcpResult(await bridgePost('/pixel', { selector, points, waitMs, tabId })),
);

// Snapshot (accessibility tree)
server.tool(
	'browser_snapshot',
	'Return the accessibility tree of the page as a compact, pruned projection: ignored and nameless nodes are dropped and each node is flattened to { nodeId, role, name, value?, ... }. Good for understanding page structure before clicking or typing. NOTE: on a real app page even the pruned tree can be large — scope it with `selector`, or use `interactiveOnly` when you just need the clickable/typeable elements. To read one specific value, browser_eval is far cheaper than a snapshot. Returns { nodes, totalMatched, totalRaw, truncated, note? }.',
	{
		tabId: z.string().optional().describe(tabIdDescription),
		selector: z.string().optional().describe('CSS selector to scope the tree to. Strongly recommended on app pages — returns only this element and its descendants.'),
		interactiveOnly: z.boolean().optional().describe('Only return actionable roles (button, link, textbox, checkbox, tab, …). Best first call when you intend to click or type.'),
		limit: z.number().optional().describe('Max nodes to return (default 1500). Response reports `truncated` and `totalMatched` when it caps.'),
		includeIgnored: z.boolean().optional().describe('Include nodes marked ignored by the accessibility tree. Off by default; they are invisible to assistive tech and mostly noise.'),
		full: z.boolean().optional().describe('Return the raw unpruned CDP AX nodes instead. Very large — only when the compact projection is genuinely insufficient.'),
	},
	async ({ tabId, selector, interactiveOnly, limit, includeIgnored, full }) => {
		const params = new URLSearchParams();
		if (tabId) params.set('tabId', tabId);
		if (selector) params.set('selector', selector);
		if (interactiveOnly) params.set('interactiveOnly', 'true');
		if (limit !== undefined) params.set('limit', String(limit));
		if (includeIgnored) params.set('includeIgnored', 'true');
		if (full) params.set('full', 'true');
		const qs = params.toString();
		return toMcpResult(await bridgeFetch(`/snapshot${qs ? `?${qs}` : ''}`));
	},
);

// DOM
server.tool(
	'browser_dom',
	'Return the full outer HTML of the page. Heavy — only use when you truly need complete markup. For reading specific data, browser_eval is much faster.',
	{ tabId: z.string().optional().describe(tabIdDescription) },
	async ({ tabId }) => {
		const qs = tabId ? `?tabId=${encodeURIComponent(tabId)}` : '';
		return toMcpResult(await bridgeFetch(`/dom${qs}`));
	},
);

// Console
server.tool(
	'browser_console',
	'Read recent console output (last 200 per tab). Each entry has type, text, timestamp, tabId, and optional target (worker/iframe/service_worker). Omit tabId to aggregate across all tabs.',
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
	'Read recent network requests (last 200 per tab). Each entry has requestId, method, url, status, type, timestamps, tabId, and optional target. Useful for diagnosing failed API calls or missing resources. Omit tabId to aggregate.',
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

// Download behavior
server.tool(
	'browser_download_set',
	'Configure where the integrated browser saves downloads, bypassing the native save dialog. Default path is `tmp/downloads` (relative to the open workspace folder); call this before triggering a download (click, navigation to a file URL) so the file lands somewhere predictable. Path is scoped to the workspace: relative paths resolve against it; absolute paths must live inside it. Behavior persists for the life of the browser session — pass `behavior:"default"` to restore the normal save dialog when you\'re done. Pair with `browser_downloads` to see file names and progress. Tip: add `tmp/` to .gitignore.',
	{
		path: z.string().optional().describe('Directory to save downloads to. Absolute or workspace-relative; resolved against the open workspace folder; the resolved path must live inside it. Parent directories are created automatically. Default: `tmp/downloads`. Ignored when behavior is `deny` or `default`.'),
		behavior: z.enum(['allow', 'allowAndName', 'deny', 'default']).optional().describe('CDP setDownloadBehavior. `allow` (default) saves with the server-suggested filename — Chromium adds " (1)" on collision. `allowAndName` saves with the GUID; only useful if you specifically need to handle naming yourself via the events in browser_downloads. `deny` blocks downloads silently. `default` restores the native "ask where to save" dialog.'),
		tabId: z.string().optional().describe(tabIdDescription),
	},
	async ({ path: pathArg, behavior, tabId }) => {
		const effectiveBehavior = behavior ?? 'allow';
		let resolvedPath: string | undefined;
		if (effectiveBehavior === 'allow' || effectiveBehavior === 'allowAndName') {
			const instance = discoverInstance();
			if (!instance?.workspace) {
				return { content: [{ type: 'text' as const, text: `Error: download path requires an open workspace folder` }], isError: true };
			}
			const workspace = instance.workspace;
			const inputPath = pathArg ?? 'tmp/downloads';
			resolvedPath = path.isAbsolute(inputPath)
				? path.resolve(inputPath)
				: path.resolve(workspace, inputPath);
			if (resolvedPath !== workspace && !resolvedPath.startsWith(workspace + path.sep)) {
				return { content: [{ type: 'text' as const, text: `Error: download path must be inside the workspace (${workspace}); got ${resolvedPath}` }], isError: true };
			}
		}
		return toMcpResult(await bridgePost('/download/set', { path: resolvedPath, behavior: effectiveBehavior, tabId }));
	},
);

// Downloads buffer
server.tool(
	'browser_downloads',
	'Read recent download events (last 50 per tab). Each entry: `{ guid, url, suggestedFilename, state, totalBytes?, receivedBytes?, downloadPath?, startedAt, updatedAt, tabId }`. State is `inProgress`, `completed`, or `canceled`. After completion with behavior:"allow", the file lives at `<downloadPath>/<suggestedFilename>` (Chromium adds " (1)" suffix on collision; not observable from CDP). Events only flow after `browser_download_set` has been called.',
	{
		limit: z.number().int().min(1).max(50).default(20).describe('Max entries to return'),
		tabId: z.string().optional().describe('Filter to one tab. Omit to aggregate across all tabs.'),
	},
	async ({ limit, tabId }) => {
		const params = new URLSearchParams({ limit: String(limit) });
		if (tabId) params.set('tabId', tabId);
		return toMcpResult(await bridgeFetch(`/downloads?${params}`));
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
	'Check the bridge connection status and — importantly — what this build can actually do. Returns `degraded: true` plus a `warning` naming the cause and remedy when the `browser` API proposal is not granted; in that mode pages you did not open can never be attached or driven, and browser_tab_open is unavailable. Also returns `tabAccess`, which says whether you may drive tabs the user opened (`allowAllExistingTabs`, off by default) — check it before telling a user why their page is not in browser_tab_list. Worth calling first when anything behaves unexpectedly, rather than inferring capability from failures.',
	{},
	async () => toMcpResult(await bridgeFetch('/status')),
);

// Tab management — requires proposed browser API on the extension side.
// On the fallback (debug-session) path, browser_tab_open returns an error;
// browser_tab_list still works (returns the single synthetic tab).

server.tool(
	'browser_tab_open',
	'Open a new browser tab at the given URL. Returns { tabId, url, title } — the tabId is the handle for subsequent tool calls. Use this when you want to keep the current page while opening another. REQUIRES VS Code launched with --enable-proposed-api thimo.integrated-browser-mcp; check browser_status `capabilities.tabOpen` first, because in a normally-installed build this is unavailable and the fallback is browser_navigate with no tabId (which drives the bridge\'s own single tab).',
	{
		url: z.string().describe('Initial URL for the new tab'),
		makeActive: z.boolean().optional().default(true).describe('Make this tab the active (default) target for subsequent tool calls'),
		beside: z.boolean().optional().describe('Open in an editor group beside the current one instead of the current group. Useful when working alongside the user, but it does split their layout — leave off unless asked.'),
	},
	async ({ url, makeActive, beside }) => toMcpResult(await bridgePost('/tab/open', { url, makeActive, beside })),
);

server.tool(
	'browser_tab_close',
	'Close a tab by id. The tab disappears from the VS Code UI.',
	{ tabId: z.string().describe('Tab id from browser_tab_list / browser_tab_open') },
	async ({ tabId }) => toMcpResult(await bridgePost(`/tab/close/${encodeURIComponent(tabId)}`, {})),
);

server.tool(
	'browser_tab_list',
	'List every tab under the bridge. Returns an array of { tabId, number, url, title, active, state, transport }. The `number` matches the "(N) " prefix shown in each tab title — if the user says "reload browser 2", find the entry with number=2 and use its tabId. `number` is null for the 21st tab and beyond (their titles show 🤯 instead of a number); for those, refer to them by tabId or URL.',
	{},
	async () => toMcpResult(await bridgeFetch('/tabs')),
);

server.tool(
	'browser_tab_activate',
	'Set which tab receives tool calls that omit tabId. Note: does not move focus in the VS Code UI (the proposed API does not expose that).',
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
