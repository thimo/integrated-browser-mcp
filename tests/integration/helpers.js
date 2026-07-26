const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vscode = require('vscode');

const EXTENSION_ID = 'thimo.integrated-browser-mcp';
const INSTANCES_DIR = path.join(os.homedir(), '.integrated-browser-mcp', 'instances');

/** Activate the extension and wait for the bridge to register an endpoint. */
async function activateBridge() {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	assert.ok(extension, `${EXTENSION_ID} is not installed in the test instance`);
	await extension.activate();
	await waitFor(() => readInstance() !== null, 'the bridge to register an instance');
	return extension;
}

/**
 * The endpoint this test run's bridge is listening on. Written by the
 * extension on start; the newest wins, since a previous run may have left one
 * behind for a process that is gone.
 */
function readInstance() {
	let entries;
	try {
		entries = fs.readdirSync(INSTANCES_DIR).filter(f => f.endsWith('.json'));
	} catch {
		return null;
	}
	const live = [];
	for (const file of entries) {
		try {
			const data = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), 'utf-8'));
			try { process.kill(data.pid, 0); } catch { continue; }
			live.push(data);
		} catch { /* skip corrupt */ }
	}
	live.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
	return live[0] ?? null;
}

/** Call the bridge's HTTP API over whichever transport it chose. */
function request(urlPath, method = 'GET', body) {
	const instance = readInstance();
	assert.ok(instance, 'no live bridge instance registered');
	const payload = body === undefined ? undefined : JSON.stringify(body);
	const options = instance.socketPath
		? { socketPath: instance.socketPath, path: urlPath, method }
		: { host: '127.0.0.1', port: instance.port, path: urlPath, method };
	if (payload) {
		options.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
	}
	return new Promise((resolve, reject) => {
		const req = http.request(options, res => {
			let data = '';
			res.setEncoding('utf-8');
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				try { resolve(JSON.parse(data)); } catch (err) { reject(new Error(`Bad JSON from ${urlPath}: ${data.slice(0, 200)}`)); }
			});
		});
		req.on('error', reject);
		if (payload) req.write(payload);
		req.end();
	});
}

/** Poll until `predicate` holds, so tests do not depend on fixed sleeps. */
async function waitFor(predicate, description, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			last = await predicate();
			if (last) return last;
		} catch (err) {
			last = err;
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

/** The page's own title, which is what an indicator prefix actually mutates. */
async function documentTitle(tabId) {
	const result = await request('/eval', 'POST', { expression: 'document.title', tabId });
	assert.ok(result.ok, `eval failed: ${result.error}`);
	return result.data;
}

async function setSetting(key, value) {
	await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
}

module.exports = { EXTENSION_ID, activateBridge, readInstance, request, waitFor, documentTitle, setSetting };
