# Integrated Browser MCP

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

Console and network events from iframes are captured alongside top-level page events. Web worker events are not currently captured — this needs a migration to VS Code's proposed `browser` API (planned for a future release).

## Getting started

1. Install the extension
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

To avoid Claude Code picking the wrong browser tool, add this to your project's `CLAUDE.md`:

```
For browser automation, use the integrated-browser-mcp MCP tools (browser_navigate, browser_screenshot, etc.), not the claude-in-chrome tools.
```

### Briefing an AI agent

The MCP server already ships with a top-level `instructions` field that explains how to use it. Most agents read this automatically on connect. If you want to reinforce or extend it, copy the block below into your project's `CLAUDE.md`:

```
The integrated-browser-mcp controls a browser visible inside VS Code's
editor area — not a separate Chrome window. The user can see exactly what
you see.

Tabs are numbered: the "(N) " prefix in each tab title corresponds to the
`number` field returned by browser_tab_list. When the user says "reload
browser 2" or "open that in tab 3", match by number.

Choose the cheapest tool for the job:
- browser_eval with a small JS expression for specific data (title, text,
  form state, computed values). Fastest.
- browser_snapshot for page structure (accessibility tree). Light.
- browser_dom only when full HTML is genuinely needed. Heavy.
- browser_screenshot only when visual verification actually matters.
- browser_console / browser_network are already buffered — read with an
  optional tabId to filter.

browser_navigate replaces the current page. Use browser_tab_open to keep
the old one.
```

### Usage with curl

```bash
# Navigate
curl -X POST http://127.0.0.1:3788/navigate \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:3000"}'

# Screenshot (returns base64 PNG)
curl http://127.0.0.1:3788/screenshot

# Run JavaScript
curl -X POST http://127.0.0.1:3788/eval \
  -H 'Content-Type: application/json' \
  -d '{"expression":"document.title"}'

# Check status
curl http://127.0.0.1:3788/status
```

## MCP tools

All interaction tools accept an optional `tabId` parameter. Omit it to target the active tab.

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_eval` | Execute JavaScript in the page |
| `browser_click` | Click an element by CSS selector |
| `browser_type` | Type text into an element by CSS selector |
| `browser_scroll` | Scroll the page or a specific element |
| `browser_screenshot` | Take a screenshot (returns image) |
| `browser_snapshot` | Get the accessibility tree |
| `browser_dom` | Get the full page HTML |
| `browser_console` | Read buffered console output (aggregates across tabs when `tabId` omitted) |
| `browser_network` | Read buffered network requests (aggregates across tabs when `tabId` omitted) |
| `browser_network_clear` | Clear the network log |
| `browser_url` | Get the current page URL |
| `browser_tab_open` | Open a new browser tab (proposed API only) |
| `browser_tab_close` | Close a tab by id |
| `browser_tab_list` | List open tabs with their ids, URLs, titles, and active flag |
| `browser_tab_activate` | Set the default target tab |
| `browser_status` | Check bridge connection status |

## HTTP API

All responses follow the format `{ ok: true, data: ... }` or `{ ok: false, error: "..." }`.

The server binds to `127.0.0.1` only — never exposed to the network.

All interaction endpoints (navigate, eval, click, type, scroll, screenshot, snapshot, dom, url) accept an optional `tabId` — as a `?tabId=` query param on GET requests or in the JSON body on POST. Omit to target the active tab.

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/status` | — | Bridge health + diagnostics (transport, active tab, buffer sizes, event counts) |
| POST | `/navigate` | `{ url, tabId? }` | Navigate to URL |
| POST | `/eval` | `{ expression, tabId? }` | Run JS in page context |
| POST | `/click` | `{ selector, tabId? }` | Click element by CSS selector |
| POST | `/type` | `{ selector, text, tabId? }` | Type into element |
| POST | `/scroll` | `{ deltaX, deltaY, selector?, tabId? }` | Scroll page or element |
| GET | `/screenshot` | `?tabId=X` | Base64 PNG screenshot |
| GET | `/snapshot` | `?tabId=X` | Accessibility tree |
| GET | `/dom` | `?tabId=X` | Full page outerHTML |
| GET | `/console` | `?limit=N&tabId=X` | Buffered console output (last 200). Aggregates across tabs when `tabId` omitted. |
| GET | `/network` | `?limit=N&filter=x&tabId=X` | Buffered network requests (last 200). Aggregates across tabs when `tabId` omitted. |
| POST | `/network/clear` | `?tabId=X` | Clear network log (one tab or all) |
| GET | `/url` | `?tabId=X` | Current page URL |
| GET | `/tabs` | — | List open tabs `[{ tabId, url, title, active, state, transport }]` |
| POST | `/tab/open` | `{ url, makeActive? }` | Open a new tab (proposed API only). Returns `{ tabId, url, title }` |
| POST | `/tab/close/:tabId` | — | Close a tab |
| POST | `/tab/activate/:tabId` | — | Set the active (default) tab |

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

## Extension settings

| Setting | Default | Description |
|---------|---------|-------------|
| `browserBridge.httpPort` | `3788` | Preferred port for the HTTP server |
| `browserBridge.autoStart` | `true` | Start the bridge automatically when VS Code opens |

## Commands

- **Browser Bridge: Start** — Start the bridge manually
- **Browser Bridge: Stop** — Stop the bridge
- **Browser Bridge: Show Status** — Show connection status

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

## Known limitations

- On the debug-session path (without the proposed API flag): the browser runs as a VS Code debug session in `noDebug` mode. This means the debug toolbar and a "(1)" badge on the Run & Debug icon appear when the browser is active.
- On the debug-session path: web worker and service worker events are not captured, and only one tab is supported.
- `/eval` executes arbitrary JavaScript in whatever page is open. Use with care.
- The browser tab opens in the VS Code editor area. It can be moved to a side panel or closed (which disconnects CDP).

## Security

- HTTP server binds to `127.0.0.1` only
- No authentication (localhost only, same as VS Code's built-in terminals)
- `/eval` runs arbitrary JS — same trust model as the DevTools console
