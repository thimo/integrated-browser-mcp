const assert = require('assert');
const vscode = require('vscode');
const { activateBridge, request } = require('./helpers');

/**
 * The viability probe. If this fails, the harness itself is not usable in this
 * environment and nothing below it is worth diagnosing — so it asserts the
 * chain end to end and nothing more: extension activates, proposal is granted,
 * bridge is listening, and it agrees about its own capabilities.
 */
suite('bridge activation', () => {
	suiteSetup(async function () {
		this.timeout(120_000); // first run downloads VS Code
		await activateBridge();
	});

	test('the browser proposal is granted in the test instance', () => {
		// Same probe the extension uses: the members exist even when ungranted
		// and throw on access, so a bare typeof check is a false positive.
		assert.strictEqual(typeof vscode.window.openBrowserTab, 'function', 'openBrowserTab missing');
		assert.ok(Array.isArray(vscode.window.browserTabs), 'browserTabs not readable — proposal not granted');
	});

	test('/status reports a healthy, non-degraded bridge', async () => {
		const status = await request('/status');
		assert.ok(status.ok, `status failed: ${status.error}`);
		assert.strictEqual(status.data.server, true);
		assert.strictEqual(status.data.capabilities.browserProposal, true);
		assert.strictEqual(status.data.degraded, false, 'bridge fell back to the debug-session path');
	});

	test('sharing is reported as unenforced by default', async () => {
		const status = await request('/status');
		assert.strictEqual(status.data.sharing.mode, 'off');
		assert.strictEqual(status.data.sharing.enforced, false);
	});
});
