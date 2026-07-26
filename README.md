# Integrated Browser MCP

[![Release](https://img.shields.io/github/v/release/thimo/vscode-integrated-browser-mcp?label=release)](https://github.com/thimo/vscode-integrated-browser-mcp/releases) [![VS Code Marketplace](https://img.shields.io/badge/marketplace-install-blue)](https://marketplace.visualstudio.com/items?itemName=thimo.integrated-browser-mcp)

Exposes VS Code's integrated browser to external agents (Claude Code, scripts, curl) via a local HTTP API and MCP server.

Every existing browser automation solution targets an external Chrome process. This extension is different: it bridges the browser **already inside VS Code** — with your session cookies, your localhost dev server, your DevTools — to any agent that can speak HTTP or MCP.

## How it works

```
Claude Code / curl / scripts
    │
    │  MCP (stdio) or HTTP
    ▼
MCP Server  ──HTTP──▶  VS Code Extension  ──CDP──▶  Integrated Browser
                       localhost:3788+               (real Chromium, in-editor)
```

The extension uses VS Code's built-in `editor-browser` and the Chrome DevTools Protocol (CDP) to provide full browser automation: navigation, JavaScript evaluation, clicking, typing, screenshots, DOM access, console and network monitoring.

## Getting started

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=thimo.integrated-browser-mcp), or run:
   ```bash
   code --install-extension thimo.integrated-browser-mcp
   ```
2. The HTTP server starts automatically on `localhost:3788`
3. For Claude Code: the MCP server is auto-configured in `~/.claude.json` on first activation
4. The browser launches lazily on the first request — no browser tab until you need one

### Usage with Claude Code

The MCP tools are available immediately. Ask Claude Code to use them by name:

```
use browser_navigate to open http://localhost:3000
```

Or reference the MCP server:

```
use the integrated-browser-mcp to open my app
```

The MCP server ships an `instructions` field that conformant clients surface to the model automatically. If your agent still picks the wrong tool (e.g. shells out to `open` instead of using `browser_navigate`), add a short hint to your project's `CLAUDE.md`:

```
For browser automation, use the integrated-browser-mcp MCP tools (browser_navigate, browser_screenshot, etc.) — never shell out to `open`/`xdg-open`/`start`.
```

### Usage with curl

```bash
curl -X POST http://127.0.0.1:3788/navigate \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:3000"}'
```

See [HTTP API](#http-api) below for the full endpoint list.

## MCP tools

All interaction tools accept an optional `tabId` parameter. Omit it to target the active tab.

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_eval` | Execute JavaScript in the page |
| `browser_click` | Click an element by CSS selector |
| `browser_type` | Type text into an element by CSS selector. `submit: true` presses Enter afterwards — form fill + submit in one call. |
| `browser_scroll` | Scroll the page or a specific element |
| `browser_screenshot` | Capture page as PNG. `fullPage` for whole-document capture; `waitMs` to delay capture for in-flight CSS transitions. |
| `browser_screenshot_slice` | Capture one viewport-height slice of a long page. For pages exceeding Chromium's single-PNG axis cap (~16k px). Pair with `browser_emulate` first. |
| `browser_emulate` | Override viewport dimensions, DPR, mobile flag, and User-Agent. Sticky until `reset:true`. |
| `browser_pixel` | Read the on-screen colour at a point or element centre, as numbers. Works on WebGL canvases where in-page readback returns black — see [Sampling colours](#sampling-colours). |
| `browser_snapshot` | Get the accessibility tree as a compact pruned projection. Scope with `selector`, filter with `interactiveOnly`, cap with `limit`; `full: true` returns the raw CDP nodes. |
| `browser_dom` | Get the full page HTML |
| `browser_markdown` | Extract page content as markdown (lightweight DOM walker, not Turndown). Pass `outputPath` to write to disk instead of returning the body — workspace-scoped. |
| `browser_console` | Read buffered console output (aggregates across tabs when `tabId` omitted) |
| `browser_network` | Read buffered network requests (aggregates across tabs when `tabId` omitted) |
| `browser_network_clear` | Clear the network log |
| `browser_download_set` | Configure where downloads land (default `tmp/downloads`, workspace-scoped) and bypass the native save dialog. See [Headless downloads](#headless-downloads). |
| `browser_downloads` | Read buffered download events (last 50 per tab, aggregates when `tabId` omitted) |
| `browser_url` | Get the current page URL |
| `browser_tab_open` | Open a new browser tab (proposed API only) |
| `browser_tab_close` | Close a tab by id |
| `browser_tab_list` | List open tabs with their ids, URLs, titles, and active flag |
| `browser_tab_activate` | Set the default target tab |
| `browser_pages_discover` | List integrated browser pages VS Code knows about, including ones the bridge isn't attached to. Requires VS Code 1.131+ — see [Page discovery](#page-discovery-vs-code-1131). |
| `browser_status` | Check bridge connection status |

## HTTP API

All responses follow the format `{ ok: true, data: ... }` or `{ ok: false, error: "..." }`.

All interaction endpoints (navigate, eval, click, type, scroll, screenshot, snapshot, dom, url) accept an optional `tabId` — as a `?tabId=` query param on GET requests or in the JSON body on POST. Omit to target the active tab.

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/status` | — | Bridge health + diagnostics (transport, active tab, buffer sizes, event counts) |
| POST | `/navigate` | `{ url, tabId? }` | Navigate to URL |
| POST | `/eval` | `{ expression, tabId? }` | Run JS in page context |
| POST | `/click` | `{ selector, tabId? }` | Click element by CSS selector |
| POST | `/type` | `{ selector, text, submit?, tabId? }` | Type into element. `submit: true` presses Enter after typing. |
| POST | `/scroll` | `{ deltaX, deltaY, selector?, tabId? }` | Scroll page or element |
| GET | `/screenshot` | `?tabId=X&fullPage=true&waitMs=N` | Base64 PNG screenshot. `fullPage=true` captures beyond the viewport. `waitMs` sleeps before capture (handles CSS transitions). |
| GET | `/screenshot-slice` | `?slice=N&tabId=X` | Viewport-height slice plus metadata. `slice` is 0-indexed; negative from end. Omit `slice` for metadata only. |
| GET | `/markdown` | `?selector=S&tabId=X` | Page content as markdown. `selector` defaults to `main` (falls back to `body`). |
| POST | `/emulate` | `{ width, height, deviceScaleFactor?, mobile?, userAgent?, reset?, tabId? }` | Device-metric override. `{reset:true}` clears. |
| GET | `/snapshot` | `?tabId=X` | Accessibility tree |
| GET | `/dom` | `?tabId=X` | Full page outerHTML |
| GET | `/console` | `?limit=N&tabId=X` | Buffered console output (last 200). Aggregates across tabs when `tabId` omitted. |
| GET | `/network` | `?limit=N&filter=x&tabId=X` | Buffered network requests (last 200). Aggregates across tabs when `tabId` omitted. |
| POST | `/network/clear` | `?tabId=X` | Clear network log (one tab or all) |
| POST | `/download/set` | `{ path?, behavior?, tabId? }` | Configure download handling. `behavior` ∈ `allow` (default) / `allowAndName` / `deny` / `default`. `path` is required for `allow`/`allowAndName` and must be absolute when called directly (the MCP layer scopes workspace-relative paths). |
| GET | `/downloads` | `?limit=N&tabId=X` | Buffered download events (last 50 per tab). Each entry: `{ guid, url, suggestedFilename, state, totalBytes?, receivedBytes?, downloadPath?, startedAt, updatedAt }`. |
| GET | `/url` | `?tabId=X` | Current page URL |
| GET | `/tabs` | — | List open tabs `[{ tabId, url, title, active, state, transport }]` |
| POST | `/tab/open` | `{ url, makeActive? }` | Open a new tab (proposed API only). Returns `{ tabId, url, title }` |
| POST | `/tab/close/:tabId` | — | Close a tab |
| POST | `/tab/activate/:tabId` | — | Set the active (default) tab |
| POST | `/pixel` | `{ selector?, points?, waitMs?, tabId? }` | Sample on-screen colour(s). `selector` samples that element's centre; `points` are page coordinates in CSS pixels. Returns `{ samples: [{ hex, r, g, b, a, x, y }] }`. |
| GET | `/pages` | — | Integrated browser pages known to VS Code, including unattached ones. Returns `{ available, pages[], unsharedCount, reason?, requires? }`. See [Page discovery](#page-discovery-vs-code-1131). |

## Knowing what your build supports

Multi-tab depends on the `browser` API proposal, which VS Code only *grants* when launched with `--enable-proposed-api thimo.integrated-browser-mcp` (or in extension development mode). Declaring it in the manifest is not enough. `GET /status` reports what is actually available:

```json
{ "capabilities": { "tabOpen": false, "attachExistingPages": false, "multiTab": false,
                    "reason": "the `browser` API proposal is declared but not granted; …" },
  "attachablePages": 1 }
```

Without the proposal the bridge **cannot attach to a page the user already opened** — there is no CDP handle for it. Lazy-launch is the attach mechanism: call `browser_navigate` with no `tabId` and the bridge creates and connects its own single tab. That opens a separate page rather than taking over the user's, so an empty `browser_tab_list` never means the browser is unreachable.

### Enabling the proposal permanently

Rather than passing a flag on every launch, add it once to your runtime arguments (Command Palette → **Preferences: Configure Runtime Arguments**), then fully quit and restart VS Code — `argv.json` is read at process start, so *Reload Window* is not enough:

```jsonc
{
  "enable-proposed-api": ["thimo.integrated-browser-mcp"]
}
```

This works on **stable** as well as Insiders. The file is per-install, so each needs its own entry:

| Install | Path |
|---|---|
| Stable | `~/.vscode/argv.json` — Windows: `%USERPROFILE%\.vscode\argv.json` |
| Insiders | `~/.vscode-insiders/argv.json` — Windows: `%USERPROFILE%\.vscode-insiders\argv.json` |

Verify it took effect with `browser_status`: expect `capabilities.browserProposal: true` and `transport: "browserTab"`. Seeing `"websocket"` means the grant did not apply and the bridge is on the debug-session fallback.

Running from source (`F5`) grants proposed APIs automatically, so no `argv.json` entry is needed for development.

### Capability matrix

Two independent switches decide what works: whether the **`browser` API proposal** is granted, and whether **chat is enabled on VS Code 1.131+** (the only source of page-sharing state).

| | `browser` proposal | Chat + VS Code ≥ 1.131 | Reachable on |
|---|---|---|---|
| **A** | granted | enabled | Insiders |
| **B** | granted | off / older | **stable + Insiders** |
| **C** | not granted | enabled | Insiders |
| **D** | not granted | off / older | **stable + Insiders** |

Two things are easy to conflate here, and they ship on different schedules:

- **The `browser` proposal is already in stable** — it has been present since 1.112. Only the *grant* is opt-in, via the `argv.json` entry below. Multi-tab and attaching to your own tabs are therefore available on stable today; they are not an Insiders feature.
- **`list_browser_pages` is not.** It landed for 1.131 ([microsoft/vscode#326976](https://github.com/microsoft/vscode/pull/326976)), and current stable is 1.130 — so page discovery is unavailable there and scenarios **A** and **C** require Insiders.

A practical consequence for stable users: because the tool does not exist, chat state is irrelevant to this extension on stable. Enabling or disabling Copilot changes nothing, and `browserBridge.lmPageDiscovery` can be set to `false` to skip the feature probe entirely. Nothing needs changing when 1.131 reaches stable — discovery is feature-detected at runtime and lights up on its own.

| Capability | A | B | C | D |
|---|:--:|:--:|:--:|:--:|
| `browser_navigate` (lazy-launch) | ✅ | ✅ | ✅ | ✅ |
| `browser_eval` / click / type / scroll | ✅ | ✅ | ✅ | ✅ |
| screenshot / dom / markdown / snapshot | ✅ | ✅ | ✅ | ✅ |
| console / network / downloads buffers | ✅ | ✅ | ✅ | ✅ |
| `browser_emulate` (viewport / DPR / UA) | ✅ | ✅ | ✅ | ✅ |
| `browser_tab_open` (multi-tab) | ✅ | ✅ | ❌ | ❌ |
| Attach to tabs the **user** opened | ✅ | ✅ | ❌ | ❌ |
| Worker / service-worker events | ✅ | ✅ | partial | partial |
| `browser_pages_discover` | ✅ | ❌ | ✅ | ❌ |
| `attachedTabId` cross-reference | ✅ | ❌ | ❌¹ | ❌ |
| `enforceSharing` can enforce | ✅ | ❌² | ✅³ | ❌² |
| Unsharing revokes access | ✅⁴ | ❌ | ✅³ | ❌ |
| Debug toolbar shown per tab | none | none | shown | shown |
| `status.degraded` | `false` | `false` | **`true`** | **`true`** |
| `status.transport` | `browserTab` | `browserTab` | `websocket` | `websocket` |
| Tabs drivable | all in window | all in window | 1 (`tab-main`) | 1 (`tab-main`) |

¹ Discovery lists the page but the bridge cannot attach to it — surfaced via `hint` and `degraded` rather than left to be inferred.
² Falls back to bridge-owned-only, not fail-open. See below.
³ Enforceable, but only over the single bridge tab.
⁴ Requires `browserBridge.enforceSharing`.

The proposal is the deciding switch: it controls multi-tab, attaching to your tabs, worker events, and whether debug toolbars appear. Chat only affects the discovery/sharing layer — **disabling Copilot costs you page discovery, never browser control**.

### Access model

Orthogonal to the above, `browserBridge.enforceSharing` decides who the bridge may drive. `GET /status` reports the resolved mode, so it never claims a guarantee it is not providing:

| `enforceSharing` | Sharing signal | `sharing.mode` | Agent may drive |
|---|---|---|---|
| `false` *(default)* | — | `off` | Every attachable tab, shared or not. Unsharing does nothing. |
| `true` | available (A / C) | `enforcing` | Bridge-opened tabs + shared pages. Unsharing detaches within ~2s; later calls on that `tabId` fail. |
| `true` | absent (B / D) | `bridge-owned-only` | Only tabs the bridge opened. Yours stay off-limits and cannot be granted — there is no share button to press. |

## Marking agent-controlled tabs

`browserBridge.tabIndicator` controls how a tab under agent control is marked:

| Value | Effect |
|---|---|
| `number` *(default)* | Prefix `(N) ` — lets you say "reload browser 2" and match `browser_tab_list`'s `number` |
| `marker` | Prefix a fixed symbol (`browserBridge.tabIndicatorText`, default `● `) — shows the tab is agent-controlled without implying an ordering that renumbers as tabs come and go |
| `off` | Never modify tab titles |

**Only tabs the bridge opened itself are marked.** The bridge attaches to every integrated browser tab in the window, so marking on adoption used to stamp a prefix onto pages *you* had opened — your page, your title, modified because an unrelated tool happened to be running. Pages you open are now left alone regardless of this setting.

Marking works by rewriting the page's real `document.title` through an injected script, since that is the only lever an extension has over the editor tab label. The page can therefore observe it: choose `off` if a page or tool needs the unmodified title — for example when reading it back via `browser_eval`, or in a test that asserts on `document.title`. Changing the setting takes effect immediately; switching to `off` restores the original titles rather than leaving them modified.

The `number` in `browser_tab_list` is always present regardless of this setting.

## Page discovery (VS Code 1.131+)

The bridge can only drive tabs it has attached to. On the proposed-API path that's every integrated browser tab in the window; on the debug-session fallback it's just the one tab the bridge launched. Neither sees pages the *user* opened, or pages owned by another window.

`browser_pages_discover` / `GET /pages` closes that blind spot by asking VS Code directly, via its built-in [`list_browser_pages`](https://github.com/microsoft/vscode/pull/326976) language model tool (`vscode.lm.invokeTool`). Use it when `browser_tab_list` looks empty but the user insists a page is open.

Each returned page carries a VS Code `pageId` — **not** a bridge `tabId`; the two namespaces are unrelated. Where the bridge already drives the same URL, the entry also gets an `attachedTabId`. Only pages with an `attachedTabId` can be acted on by the other `browser_*` tools.

Requirements — when unmet, the call returns `{ available: false, reason, requires }` and everything else keeps working:

- VS Code **1.131+** (Insiders at time of writing)
- Chat enabled and signed in
- `"chat.agent.enabled": true`
- `"workbench.browser.enableChatTools": true`

Set `"browserBridge.lmPageDiscovery": false` to disable the integration entirely.

This is deliberately discovery-only. Everything the bridge actually *does* to a page stays on CDP: VS Code's browser tools have no equivalent for buffered console/network, downloads, or device emulation, and their `run_playwright_code` is one-shot so it can't hold event listeners. Discovery is also the one browser tool that declares no confirmation prompt, so it needs no auto-approve setting — unlike `open_browser_page` / `navigate_page` / `run_playwright_code`, which raise a modal when invoked outside a chat session unless `chat.tools.global.autoApprove` is set.

## Multi-window support and port discovery

Each VS Code window gets its own browser and HTTP server. Ports are assigned automatically starting from 3788 and incrementing if already taken.

### How the MCP server finds the right window

When Claude Code calls a browser tool, the MCP server needs to know which VS Code window to talk to. It resolves this automatically:

1. Each VS Code window registers itself at `~/.integrated-browser-mcp/instances/<hash>.json` with its port, workspace path, and PID
2. The MCP server reads all instance files and filters out dead processes
3. It matches `process.cwd()` (Claude Code's working directory) against registered workspace paths — deepest match wins
4. If no workspace matches, it falls back to the most recently started instance

This means when you run Claude Code inside a VS Code terminal, it automatically connects to the browser in **that** VS Code window.

### Manual override

Set the `BROWSER_BRIDGE_PORT` environment variable to force a specific port:

```bash
BROWSER_BRIDGE_PORT=3789 claude
```

### Troubleshooting

If the MCP server connects to the wrong window, check the registered instances:

```bash
cat ~/.integrated-browser-mcp/instances/*.json
```

Stale instance files from crashed VS Code windows are cleaned up automatically on the next window startup. You can also delete them manually.

## Enabling worker event capture (proposed API)

By default the bridge launches the integrated browser via a VS Code debug session and talks to it through `vscode-js-debug`'s CDP proxy. That proxy only forwards events from the main page session — so logs and network requests from web workers and service workers never reach the `/console` and `/network` buffers.

VS Code ships a **proposed API** (`vscode.window.openBrowserTab`) that bypasses `vscode-js-debug` entirely and gives direct multiplexed access to the CDP stream. On this path, worker and iframe events are captured and tagged with a `target` field.

To enable it, launch VS Code with the proposed API flag:

```bash
code --enable-proposed-api=thimo.integrated-browser-mcp
```

The extension feature-detects the proposal at startup and uses it if available. Without the flag, the bridge falls back to the debug-session path and works exactly like before — so setting the flag is optional and safe.

Check which path you're on via the status bar tooltip (`Browser MCP: Connected (proposed)` vs `(debug-session)`), or `GET /status` → `transport: "browserTab"` vs `"websocket"`.

Caveat: the `browser` proposal is still [tracked upstream](https://github.com/microsoft/vscode/issues/300319) and its shape can change between VS Code releases. The fallback path keeps the extension usable regardless.

## Multi-tab

Multi-tab support requires the proposed API (previous section). When enabled:

- `browser_tab_open("https://example.com")` opens a new tab, returns its `tabId`.
- `browser_tab_list()` shows all open tabs — the `active` flag marks which one receives commands by default, and the `number` field (1, 2, 3…) matches the `(N) ` prefix in each tab's title. Numbers are stable per tab with reuse: close tab 3 and the next new tab gets 3, but tab 4 stays tab 4 for its lifetime.
- Every interaction tool (`browser_navigate`, `browser_eval`, `browser_click`, etc.) accepts an optional `tabId`. Omit it to target the active tab; pass it to target a specific tab.
- `browser_console` and `browser_network` aggregate across all tabs by default — each entry carries the `tabId` of the tab it came from. Pass `tabId` to filter.
- Closing a tab in the VS Code UI is picked up automatically; the bridge untracks it and the `tabId` becomes invalid.

The `(N) ` prefix is auto-applied even to pages without a `<title>` element (about:blank, raw API responses), and it re-applies after navigation. The bridge strips any prefix a prior version of the extension may have left on a pre-existing tab, so you won't see stacked markers after an upgrade.

On the debug-session fallback path, the bridge always exposes exactly one tab (synthetic id `tab-main`) and `browser_tab_open` returns an error pointing to the proposed API.

## Headless downloads

By default the integrated browser shows a native save dialog when a page initiates a download — fine for a human, fatal for an agent. `browser_download_set` switches the active tab's browser session to a configured directory so the file lands somewhere predictable, no UI blocking. `browser_downloads` exposes the buffered `Browser.downloadWillBegin` / `Browser.downloadProgress` events so the agent knows what filename Chromium picked and when the download is finished.

Typical agent flow:

1. `browser_download_set()` — defaults to `<workspace>/tmp/downloads` with `behavior:"allow"`. Parent dirs are created.
2. Trigger the download (`browser_click`, `browser_navigate` to a file URL, `browser_eval` of a form submit, …).
3. Poll `browser_downloads` until the matching entry has `state:"completed"`.
4. Read the file from `<downloadPath>/<suggestedFilename>`.
5. Optionally `browser_download_set({ behavior: "default" })` to restore the save dialog when done.

Path scoping mirrors `browser_markdown`'s `outputPath`: relative paths resolve against the open workspace folder; absolute paths must live inside it. There is no VS Code setting — the AI calls the tool when it needs the behavior.

Caveats:
- Behavior is **per browser session**, not per tab — Chromium's `Browser.setDownloadBehavior` is browser-level. Calling `browser_download_set` on any tab affects all tabs of that browser.
- With `behavior:"allow"` (default), Chromium silently appends ` (1)`, ` (2)`, … to filenames on collision. CDP doesn't expose the suffix; if the agent cares about exact filenames, clear `tmp/downloads` first or use `behavior:"allowAndName"` (saves under the GUID; rename via the events from `browser_downloads`).
- Add `tmp/` to `.gitignore` — downloads are throwaway.

## Limitations and trust model

- HTTP server binds to `127.0.0.1` only — never network-exposed. No authentication, same trust model as VS Code's built-in terminals.
- `/eval` runs arbitrary JavaScript in the open page — same trust model as the DevTools console. Don't pass untrusted input.
- On the debug-session path (default, no proposed-API flag): only one tab, web worker and service worker events not captured, and the debug toolbar / "(1)" badge appears while the browser is active.
- The browser tab lives in the VS Code editor area. Moving it to a side panel is fine; closing it disconnects CDP.
