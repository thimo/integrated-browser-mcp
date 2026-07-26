const assert = require('assert');
const vscode = require('vscode');
const { activateBridge, request, waitFor, documentTitle, setSetting } = require('./helpers');

const BLANK = 'about:blank';

/**
 * Tab ownership and the indicator that depends on it.
 *
 * This is the case a unit test cannot reach and a human cannot reliably
 * reproduce: whether a tab is the bridge's or the user's is decided by a race
 * between `onDidOpenBrowserTab` and the bridge's own `openTab`, and the wrong
 * answer is invisible until either a page's title is mutated that should not
 * have been, or `enforceSharing` revokes the agent's own tab.
 */
suite('tab ownership', () => {
	const opened = [];

	suiteSetup(async function () {
		this.timeout(120_000);
		await activateBridge();
		await setSetting('browserBridge.tabIndicator', 'number');
	});

	teardown(async () => {
		// Close anything a test left behind so cases stay independent.
		while (opened.length) {
			const tab = opened.pop();
			try { await tab.close(); } catch { /* already gone */ }
		}
		const tabs = await request('/tabs');
		for (const tab of tabs.data ?? []) {
			await request(`/tab/close/${encodeURIComponent(tab.tabId)}`, 'POST').catch(() => undefined);
		}
	});

	test('a tab the user opens is left unmarked', async () => {
		// Opening through the VS Code API directly is exactly what the user
		// does; the bridge adopts it, but must not claim or mark it.
		const tab = await vscode.window.openBrowserTab(BLANK, { background: true, preserveFocus: true });
		opened.push(tab);

		const entry = await waitFor(async () => {
			const tabs = await request('/tabs');
			return (tabs.data ?? []).find(t => t.url === BLANK || t.url === '');
		}, 'the bridge to adopt the user-opened tab');

		const title = await documentTitle(entry.tabId);
		assert.ok(!/^\(\d+\)\s/.test(title), `user-opened tab was marked: ${JSON.stringify(title)}`);
	});

	test('a tab the bridge opens is marked', async () => {
		const result = await request('/tab/open', 'POST', { url: BLANK, makeActive: false });
		assert.ok(result.ok, `tab/open failed: ${result.error}`);

		const title = await waitFor(
			async () => {
				const current = await documentTitle(result.data.tabId);
				return /^\(\d+\)\s/.test(current) ? current : null;
			},
			'the bridge-opened tab to be marked',
		);
		assert.match(title, /^\(\d+\)\s/);
	});

	test('ownership survives the open event winning the adoption race', async () => {
		// The regression: `onDidOpenBrowserTab` fires for tabs the bridge opens
		// and adopts them *without* ownership. Whichever call lands first used
		// to decide, so the bridge's own tab could be recorded as the user's.
		const results = await Promise.all([
			request('/tab/open', 'POST', { url: BLANK, makeActive: false }),
			request('/tab/open', 'POST', { url: BLANK, makeActive: false }),
		]);
		for (const result of results) {
			assert.ok(result.ok, `tab/open failed: ${result.error}`);
			const title = await waitFor(
				async () => {
					const current = await documentTitle(result.data.tabId);
					return /^\(\d+\)\s/.test(current) ? current : null;
				},
				`tab ${result.data.tabId} to be marked`,
			);
			assert.match(title, /^\(\d+\)\s/);
		}
	});

	test('switching the indicator off restores the original title', async () => {
		const result = await request('/tab/open', 'POST', { url: BLANK, makeActive: false });
		assert.ok(result.ok);
		await waitFor(async () => /^\(\d+\)\s/.test(await documentTitle(result.data.tabId)), 'the tab to be marked');

		try {
			await setSetting('browserBridge.tabIndicator', 'off');
			// Turning it off must clean up, not merely stop marking new tabs —
			// otherwise every already-marked page stays modified until reopened.
			await waitFor(
				async () => !/^\(\d+\)\s/.test(await documentTitle(result.data.tabId)),
				'the indicator to be removed from the existing tab',
			);
		} finally {
			await setSetting('browserBridge.tabIndicator', 'number');
		}
	});

	test('marker mode uses the symbol rather than a number', async () => {
		try {
			await setSetting('browserBridge.tabIndicator', 'marker');
			await setSetting('browserBridge.tabIndicatorText', '@@ ');
			const result = await request('/tab/open', 'POST', { url: BLANK, makeActive: false });
			assert.ok(result.ok);
			const title = await waitFor(
				async () => {
					const current = await documentTitle(result.data.tabId);
					return current.startsWith('@@ ') ? current : null;
				},
				'the tab to carry the marker',
			);
			assert.ok(title.startsWith('@@ '), title);
			assert.ok(!/^\(\d+\)\s/.test(title), 'marker mode should not number');
		} finally {
			await setSetting('browserBridge.tabIndicator', 'number');
			await setSetting('browserBridge.tabIndicatorText', undefined);
		}
	});
});
