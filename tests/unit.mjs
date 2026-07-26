/**
 * Unit tests for the pure functions that parse or transform untrusted input.
 *
 * These four are the ones that fail *silently* — a mis-implemented PNG
 * un-filter or AX filter returns plausible-looking data rather than throwing,
 * so a caller confidently reports the wrong answer. Everything else in the
 * extension needs a live browser and is covered by manual testing.
 *
 * Run with `npm run test:unit`. No test framework: the modules import `vscode`,
 * which only exists inside the extension host, so each is bundled with esbuild
 * against a stub. That is also why this is a plain script rather than
 * `vscode-test` — none of this needs an extension host.
 */
import * as esbuild from 'esbuild';
import { createRequire } from 'module';
import zlib from 'zlib';

const VSCODE_STUB = `
	export const workspace = { getConfiguration: () => ({ get: (_k, d) => d }) };
	export const window = {};
	export const lm = {};
	export const debug = {};
	export class CancellationTokenSource { constructor() { this.token = {}; } cancel() {} dispose() {} }
	export class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
`;

const stubVscode = {
	name: 'stub-vscode',
	setup(build) {
		build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: VSCODE_STUB, loader: 'js' }));
	},
};

async function load(entry) {
	const result = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'cjs',
		platform: 'node',
		logLevel: 'silent',
		external: ['express', 'ws'],
		plugins: [stubVscode],
	});
	const module = { exports: {} };
	new Function('module', 'exports', 'require', result.outputFiles[0].text)(
		module, module.exports, createRequire(import.meta.url),
	);
	return module.exports;
}

let failures = 0;
let checks = 0;
const eq = (name, actual, expected) => {
	checks++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
};
const throws = (name, fn) => {
	checks++;
	try { fn(); failures++; console.log(`  FAIL ${name} (expected a throw)`); } catch { /* expected */ }
};
const section = name => console.log(`\n${name}`);

// ---------------------------------------------------------------- cdp-tab
{
	section('stripComposedLabel — BrowserTab.title is an editor label, not document.title');
	const { stripComposedLabel: strip } = await load('src/cdp-tab.ts');

	eq('strips the origin suffix', strip('Google (https://www.google.com/)', 'https://www.google.com/?gws_rd=ssl'), 'Google');
	eq('handles a query on the tab url', strip('Search - Microsoft Bing (https://www.bing.com/)', 'https://www.bing.com/?toWww=1'), 'Search - Microsoft Bing');
	eq('keeps parentheses inside the title', strip('Profit (Q3) (https://x.com/)', 'https://x.com/a'), 'Profit (Q3)');
	// The guard that matters: only strip when the suffix really is this page.
	eq('leaves a foreign url alone', strip('Foo (https://evil.com)', 'https://good.com/'), 'Foo (https://evil.com)');
	eq('leaves a real parenthetical alone', strip('Rust (programming language)', 'https://en.wikipedia.org/wiki/Rust'), 'Rust (programming language)');
	eq('passes through an unsuffixed title', strip('Plain Title', 'https://x.com/'), 'Plain Title');
	eq('needs a url to compare against', strip('Google (https://www.google.com/)', ''), 'Google (https://www.google.com/)');
	eq('handles about:blank', strip('Untitled (about:blank)', 'about:blank'), 'Untitled');
}

// ---------------------------------------------------------------- lm-pages
{
	section('parsePageListing — VS Code emits freeform text, not JSON');
	const { parsePageListing: parse, sanitizeRaw } = await load('src/lm-pages.ts');

	const listing = [
		'The following browser pages are currently shared with you and can be interacted with using the browser tools:',
		'- [page-abc] Pottagold (http://localhost:3000/) (active)',
		'- [page-def] Profit and loss (Q3) (http://localhost:3000/reports) (visible)',
		'- [page-ghi] Untitled (about:blank) (not visible)',
		'',
		'2 pages are open but not shared.',
		"Use the 'open_browser_page' tool to open a new page.",
	].join('\n');

	const parsed = parse(listing);
	eq('parses every entry', parsed.pages.length, 3);
	eq('reads the unshared count', parsed.unsharedCount, 2);
	eq('plain page', parsed.pages[0], { pageId: 'page-abc', title: 'Pottagold', url: 'http://localhost:3000/', visibility: 'active', blocked: false });
	// URL is the *last* parenthesised group, so titles may contain parentheses.
	eq('title containing parentheses', parsed.pages[1], { pageId: 'page-def', title: 'Profit and loss (Q3)', url: 'http://localhost:3000/reports', visibility: 'visible', blocked: false });
	eq('about:blank and multiword visibility', parsed.pages[2], { pageId: 'page-ghi', title: 'Untitled', url: 'about:blank', visibility: 'not visible', blocked: false });

	// A policy-blocked page has no URL group at all.
	eq('policy-blocked page', parse('- [p-x] Blocked by network domain policy (active)').pages[0],
		{ pageId: 'p-x', title: 'Blocked by network domain policy', url: null, visibility: 'active', blocked: true });

	eq('singular phrasing', parse('1 page is open but not shared.').unsharedCount, 1);
	eq('nothing shared', parse('No browser pages are currently shared with you.\n\n3 pages are open but not shared.'), { pages: [], unsharedCount: 3 });
	eq('nothing open', parse('No browser pages are currently open.'), { pages: [], unsharedCount: 0 });
	eq('url containing parentheses', parse('- [p1] Doc (https://ex.com/a_(b)) (visible)').pages[0].url, 'https://ex.com/a_(b)');

	// Guidance naming tools we do not expose would be acted on by a model.
	eq('strips foreign tool guidance', /open_browser_page/.test(sanitizeRaw(listing)), false);
	eq('keeps the rest of the listing', sanitizeRaw(listing).includes('2 pages are open but not shared.'), true);
}

// ------------------------------------------------------------ http-server
{
	section('projectAXNodes — a raw SPA tree is six figures of characters');
	const { projectAXNodes: project, descendantsOf } = await load('src/http-server.ts');
	const v = value => ({ value });

	const nodes = [
		{ nodeId: '1', role: v('RootWebArea'), name: v('PrintStream'), childIds: ['2', '3'] },
		{ nodeId: '2', role: v('button'), name: v('Save'), properties: [
			{ name: 'disabled', value: v(false) }, { name: 'focused', value: v(true) }, { name: 'live', value: v('polite') },
		] },
		{ nodeId: '3', role: v('generic'), name: v(''), childIds: ['4'] },
		{ nodeId: '4', role: v('textbox'), name: v('Search'), value: v('abc') },
		{ nodeId: '5', role: v('StaticText'), name: v('hidden'), ignored: true },
		{ nodeId: '6', role: v('button'), name: v('') },
		{ nodeId: '7', role: v('InlineTextBox'), name: v('duplicate of parent') },
	];

	eq('drops ignored, unnamed generics and duplicate roles', project(nodes).map(n => n.nodeId), ['1', '2', '4', '6']);
	eq('flattens the value wrappers', project(nodes)[2], { nodeId: '4', role: 'textbox', name: 'Search', value: 'abc' });
	eq('keeps informative properties, drops defaults', project(nodes)[1], { nodeId: '2', role: 'button', name: 'Save', focused: true });
	// An unnamed button is still actionable (and an a11y bug worth surfacing).
	eq('keeps unnamed actionable nodes', project(nodes)[3], { nodeId: '6', role: 'button' });
	eq('interactiveOnly keeps only actionable roles', project(nodes, { interactiveOnly: true }).map(n => n.role), ['button', 'textbox', 'button']);
	eq('includeIgnored restores them', project(nodes, { includeIgnored: true }).map(n => n.nodeId), ['1', '2', '4', '5', '6']);

	eq('descendantsOf includes root and children', descendantsOf(nodes, '3').map(n => n.nodeId), ['3', '4']);
	eq('descendantsOf tolerates an unknown root', descendantsOf(nodes, 'nope'), []);
	eq('descendantsOf survives a cyclic tree', descendantsOf([{ nodeId: 'a', childIds: ['b'] }, { nodeId: 'b', childIds: ['a'] }], 'a').map(n => n.nodeId), ['a', 'b']);

	// The point of the exercise: framework wrappers must collapse to nothing.
	const spa = [];
	for (let i = 0; i < 1000; i++) spa.push({ nodeId: `g${i}`, role: v('generic'), name: v('') });
	for (let i = 0; i < 20; i++) spa.push({ nodeId: `b${i}`, role: v('button'), name: v(`Action ${i}`) });
	eq('only meaningful nodes survive', project(spa).length, 20);
}

// -------------------------------------------------------------------- png
{
	section('decodePng — a wrong un-filter yields plausible but wrong colours');
	const { decodePng, pixelAt } = await load('src/png.ts');

	// Encode by hand so the test does not depend on an encoder we also wrote.
	const table = (() => {
		const t = [];
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
			t[n] = c >>> 0;
		}
		return t;
	})();
	const crc32 = buf => {
		let x = 0xFFFFFFFF;
		for (const b of buf) x = table[(x ^ b) & 0xFF] ^ (x >>> 8);
		return (x ^ 0xFFFFFFFF) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const makePng = (w, h, pixels, filterRow) => {
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
		ihdr[8] = 8;  // bit depth
		ihdr[9] = 6;  // RGBA
		const rows = [];
		for (let y = 0; y < h; y++) {
			const raw = Buffer.alloc(w * 4);
			for (let x = 0; x < w; x++) {
				const p = pixels[y * w + x];
				for (let c = 0; c < 4; c++) raw[x * 4 + c] = p[c];
			}
			rows.push(filterRow(raw, y, pixels, w));
		}
		return Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk('IHDR', ihdr),
			chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
			chunk('IEND', Buffer.alloc(0)),
		]);
	};

	const pixels = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [18, 52, 86, 128]];
	const none = raw => Buffer.concat([Buffer.from([0]), raw]);
	const image = decodePng(makePng(2, 2, pixels, none));

	eq('reads the header', [image.width, image.height, image.channels], [2, 2, 4]);
	eq('red', pixelAt(image, 0, 0), { r: 255, g: 0, b: 0, a: 255, hex: '#ff0000' });
	eq('green', pixelAt(image, 1, 0), { r: 0, g: 255, b: 0, a: 255, hex: '#00ff00' });
	eq('blue', pixelAt(image, 0, 1), { r: 0, g: 0, b: 255, a: 255, hex: '#0000ff' });
	eq('alpha and zero-padded hex', pixelAt(image, 1, 1), { r: 18, g: 52, b: 86, a: 128, hex: '#123456' });
	eq('clamps out-of-range coordinates', pixelAt(image, 99, 99), { r: 18, g: 52, b: 86, a: 128, hex: '#123456' });

	// Chromium picks filters per scanline, so the un-filters must all agree.
	const sub = makePng(2, 2, pixels, raw => {
		const out = Buffer.from(raw);
		for (let i = raw.length - 1; i >= 4; i--) out[i] = (raw[i] - raw[i - 4]) & 0xff;
		return Buffer.concat([Buffer.from([1]), out]);
	});
	eq('filter 1 (Sub)', pixelAt(decodePng(sub), 1, 1), { r: 18, g: 52, b: 86, a: 128, hex: '#123456' });

	const up = makePng(2, 2, pixels, (raw, y, px, w) => {
		if (y === 0) return Buffer.concat([Buffer.from([0]), raw]);
		const prev = Buffer.alloc(w * 4);
		for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) prev[x * 4 + c] = px[x][c];
		const out = Buffer.alloc(raw.length);
		for (let i = 0; i < raw.length; i++) out[i] = (raw[i] - prev[i]) & 0xff;
		return Buffer.concat([Buffer.from([2]), out]);
	});
	eq('filter 2 (Up)', pixelAt(decodePng(up), 0, 1), { r: 0, g: 0, b: 255, a: 255, hex: '#0000ff' });

	throws('rejects a non-PNG', () => decodePng(Buffer.from('definitely not a png')));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
	console.log(`${failures} FAILED`);
	process.exit(1);
}
