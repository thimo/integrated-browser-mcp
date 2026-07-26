import { defineConfig } from '@vscode/test-cli';

/**
 * Integration tests: these launch a real VS Code with the extension loaded,
 * which is the only way to exercise the parts that matter most — tab adoption,
 * ownership, and sharing enforcement all depend on VS Code's own events and
 * cannot be faked in a unit test.
 *
 * `extensionDevelopmentPath` (which the CLI sets from `extensionDevelopment`)
 * grants proposed APIs declared in package.json automatically, the same way F5
 * does — so these run on the granted path without needing an argv.json entry.
 */
export default defineConfig({
	files: 'tests/integration/**/*.test.js',
	version: 'stable',
	mocha: {
		ui: 'tdd',
		// Downloading VS Code on a cold run, plus browser launch, is slow.
		timeout: 120_000,
	},
	launchArgs: [
		// Belt and braces: dev mode already grants it, but be explicit so a
		// failure here is unambiguous rather than looking like a bridge bug.
		'--enable-proposed-api=thimo.integrated-browser-mcp',
		// Keep the run hermetic — unrelated extensions must not adopt browser
		// tabs or race the bridge.
		'--disable-workspace-trust',
	],
});
