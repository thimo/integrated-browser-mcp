const assert = require('assert');
const vscode = require('vscode');
const { activateBridge, request, waitFor, documentTitle, setSetting } = require('./helpers');

// Distinct fixtures: the suiteSetup probe opens a bridge-owned page, and a
// shared URL would let the "user opened it" lookup match that already-marked
// tab instead of the one the test opened.
const BRIDGE_PAGE = 'data:text/html,<title>BridgePage</title><p>b';
const USER_PAGE = 'data:text/html,<title>UserPage</title><p>u';

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

		// Everything below needs a browser page that stays open. Inside
		// `@vscode/test-electron` the browser view is created and then closed
		// again immediately — `openBrowserTab` resolves, the bridge adopts the
		// tab, and a moment later it is gone and CDP is disconnected. Software
		// rendering flags (--disable-gpu, --use-gl=swiftshader) do not change
		// it, so it appears the view needs a real rendering surface.
		//
		// Skip rather than fail: these are meaningful wherever the integrated
		// browser actually runs (a desktop session, or F5), and a red suite
		// that only means "wrong environment" trains people to ignore it.
		const probe = await request('/tab/open', 'POST', { url: BRIDGE_PAGE, makeActive: false });
		const survived = probe.ok && await waitFor(
			async () => ((await request('/tabs')).data ?? []).length > 0,
			'the probe tab to stay open',
			5_000,
		).catch(() => false);
		if (!survived) {
			console.log('    [skipped] the integrated browser does not stay open in this environment');
			this.skip();
		}
		// Close the probe tab: it is bridge-owned and marked, and would
		// otherwise be mistaken for a user-opened one.
		for (const tab of (await request('/tabs')).data ?? []) {
			await request(`/tab/close/${encodeURIComponent(tab.tabId)}`, 'POST').catch(() => undefined);
		}
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
		const tab = await vscode.window.openBrowserTab(USER_PAGE, { background: true, preserveFocus: true });
		opened.push(tab);

		const entry = await waitFor(async () => {
			const tabs = await request('/tabs');
			// data: URLs come back percent-encoded, so match on a marker that
			// survives encoding rather than the literal string passed in.
			// Wait for the CDP session too: the entry appears in /tabs before
			// the session is up, and evaluating too early fails as "not connected".
			return (tabs.data ?? []).find(t => t.url.includes('UserPage') && t.state === 'connected');
		}, 'the bridge to adopt the user-opened tab');

		const title = await documentTitle(entry.tabId);
		assert.ok(!/^\(\d+\)\s/.test(title), `user-opened tab was marked: ${JSON.stringify(title)}`);
	});

	test('a tab the bridge opens is marked', async () => {
		const result = await request('/tab/open', 'POST', { url: BRIDGE_PAGE, makeActive: false });
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
			request('/tab/open', 'POST', { url: BRIDGE_PAGE, makeActive: false }),
			request('/tab/open', 'POST', { url: BRIDGE_PAGE, makeActive: false }),
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
		const result = await request('/tab/open', 'POST', { url: BRIDGE_PAGE, makeActive: false });
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

	test('re-applying a marker does not compound it', async () => {
		try {
			await setSetting('browserBridge.tabIndicator', 'marker');
			await setSetting('browserBridge.tabIndicatorText', '@@ ');
			const result = await request('/tab/open', 'POST', { url: BRIDGE_PAGE, makeActive: false });
			assert.ok(result.ok);
			await waitFor(async () => (await documentTitle(result.data.tabId)).startsWith('@@ '), 'the marker');

			// Re-assert the same indicator; the title script must strip the
			// marker it already added rather than prepend a second one.
			await setSetting('browserBridge.tabIndicatorText', '@@ ');
			await setSetting('browserBridge.tabIndicator', 'number');
			const numbered = await waitFor(
				async () => {
					const current = await documentTitle(result.data.tabId);
					return /^\(\d+\)\s/.test(current) ? current : null;
				},
				'the number to replace the marker',
			);
			assert.ok(!numbered.includes('@@'), `marker residue left behind: ${JSON.stringify(numbered)}`);
		} finally {
			await setSetting('browserBridge.tabIndicator', 'number');
			await setSetting('browserBridge.tabIndicatorText', undefined);
		}
	});

	test('user tabs take no number, and numbers are reused after close', async () => {
		// A user tab must not consume a slot, or the agent's first tab shows
		// as "(2)" with no visible "(1)" anywhere.
		const userTab = await vscode.window.openBrowserTab(USER_PAGE, { background: true, preserveFocus: true });
		opened.push(userTab);
		await waitFor(
			async () => ((await request('/tabs')).data ?? []).find(t => t.url.includes('UserPage') && t.state === 'connected'),
			'the user tab to be adopted',
		);

		const first = await request('/tab/open', 'POST', { url: BRIDGE_PAGE, makeActive: false });
		assert.ok(first.ok);
		const firstEntry = await waitFor(
			async () => ((await request('/tabs')).data ?? []).find(t => t.tabId === first.data.tabId),
			'the agent tab to appear',
		);
		assert.strictEqual(firstEntry.number, 1, 'agent tab should be 1 despite a user tab being open');

		const userEntry = ((await request('/tabs')).data ?? []).find(t => t.url.includes('UserPage'));
		assert.strictEqual(userEntry.number, null, 'user tab should hold no number');

		// Closing frees the slot rather than incrementing forever.
		await request(`/tab/close/${encodeURIComponent(first.data.tabId)}`, 'POST');
		const second = await request('/tab/open', 'POST', { url: BRIDGE_PAGE, makeActive: false });
		assert.ok(second.ok);
		const secondEntry = await waitFor(
			async () => ((await request('/tabs')).data ?? []).find(t => t.tabId === second.data.tabId),
			'the replacement tab to appear',
		);
		assert.strictEqual(secondEntry.number, 1, 'closed tab number should be reused');
	});

	test('marker mode uses the symbol rather than a number', async () => {
		try {
			await setSetting('browserBridge.tabIndicator', 'marker');
			await setSetting('browserBridge.tabIndicatorText', '@@ ');
			const result = await request('/tab/open', 'POST', { url: BRIDGE_PAGE, makeActive: false });
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
