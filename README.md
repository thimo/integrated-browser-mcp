# VS Code Browser Bridge

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
use the vscode-browser-bridge to open my app
```

To avoid Claude Code picking the wrong browser tool, add this to your project's `CLAUDE.md`:

```
For browser automation, use the vscode-browser-bridge MCP tools (browser_navigate, browser_screenshot, etc.), not the claude-in-chrome tools.
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
| `browser_console` | Read buffered console output |
| `browser_network` | Read buffered network requests |
| `browser_url` | Get the current page URL |
| `browser_status` | Check bridge connection status |

## HTTP API

All responses follow the format `{ ok: true, data: ... }` or `{ ok: false, error: "..." }`.

The server binds to `127.0.0.1` only — never exposed to the network.

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/status` | — | Bridge health check |
| POST | `/navigate` | `{ url }` | Navigate to URL |
| POST | `/eval` | `{ expression }` | Run JS in page context |
| POST | `/click` | `{ selector }` | Click element by CSS selector |
| POST | `/type` | `{ selector, text }` | Type into element |
| POST | `/scroll` | `{ deltaX, deltaY, selector? }` | Scroll page or element |
| GET | `/screenshot` | — | Base64 PNG screenshot |
| GET | `/snapshot` | — | Accessibility tree |
| GET | `/dom` | — | Full page outerHTML |
| GET | `/console` | `?limit=N` | Buffered console output (last 200) |
| GET | `/network` | `?limit=N&filter=x` | Buffered network requests (last 200) |
| POST | `/network/clear` | — | Clear network log |
| GET | `/url` | — | Current page URL |
| GET | `/tabs` | — | List browser tabs |
| POST | `/tabs/:id/activate` | — | Switch to a tab |

## Multi-window support

Each VS Code window gets its own browser and HTTP server on its own port (starting from 3788, auto-incrementing if taken). The MCP server discovers the correct port by matching your working directory against registered VS Code workspaces.

Instance registration files are stored in `~/.vscode-browser-bridge/instances/` and cleaned up automatically when VS Code windows close or stale processes are detected.

## Extension settings

| Setting | Default | Description |
|---------|---------|-------------|
| `browserBridge.httpPort` | `3788` | Preferred port for the HTTP server |
| `browserBridge.autoStart` | `true` | Start the bridge automatically when VS Code opens |

## Commands

- **Browser Bridge: Start** — Start the bridge manually
- **Browser Bridge: Stop** — Stop the bridge
- **Browser Bridge: Show Status** — Show connection status

## Known limitations

- The browser runs as a VS Code debug session (`noDebug` mode). This means the debug toolbar and a "(1)" badge on the Run & Debug icon appear when the browser is active. This is a VS Code limitation — CDP access requires a debug session.
- `/eval` executes arbitrary JavaScript in whatever page is open. Use with care.
- The browser tab opens in the VS Code editor area. It can be moved to a side panel or closed (which disconnects CDP).

## Security

- HTTP server binds to `127.0.0.1` only
- No authentication (localhost only, same as VS Code's built-in terminals)
- `/eval` runs arbitrary JS — same trust model as the DevTools console
