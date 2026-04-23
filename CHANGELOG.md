# Changelog

All notable changes to the Integrated Browser MCP extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-23

### Fixed
- Console and network buffers were silently empty. vscode-js-debug's CDP proxy only forwards events the client has explicitly subscribed to; the bridge never subscribed. Now calls `JsDebug.subscribe` for `Runtime.*`, `Network.*`, `Target.*`, and `Page.*` on connect.

### Added
- Iframe console and network events are now captured via the primary page session.
- Optional `target` field on `/console` and `/network` entries for events originating in an attached child CDP session (e.g. `iframe`, `worker`, `service_worker`). Whether child sessions attach depends on the underlying integrated browser; on VS Code 1.116 workers don't propagate through the proxy, on 1.117+ with the [new browserView CDP multiplexer](https://github.com/microsoft/vscode/pull/311049) they may.
- `/status` exposes diagnostic fields: `pageSessionId`, `children`, `consoleBufferSize`, `networkBufferSize`, and per-method `events` counters. Useful for troubleshooting event flow.
- CDP bootstrap performs an explicit `Target.attachToBrowserTarget` + `Target.attachToTarget` handshake to obtain a page session id, matching the protocol required by VS Code 1.117's integrated browser CDP proxy. Backwards-compatible with 1.112-1.116.

### Changed
- Minimum VS Code version bumped from 1.110 to 1.112, where [`editor-browser` became a first-class stable debug type](https://github.com/microsoft/vscode-js-debug/pull/2329) with supported `launch` + `attach`.

## [0.1.0] — 2026-04-10

Initial public release.

### Added
- Bridge from VS Code's integrated browser (`editor-browser` debug session) to external agents via the Chrome DevTools Protocol.
- Local HTTP API on `127.0.0.1:3788` with endpoints for navigation, JavaScript evaluation, clicking, typing, scrolling, screenshots, accessibility snapshots, DOM access, console buffering, network buffering, tab management, and status.
- Bundled MCP stdio server exposing the HTTP API as tools (`browser_navigate`, `browser_eval`, `browser_click`, `browser_type`, `browser_scroll`, `browser_screenshot`, `browser_snapshot`, `browser_dom`, `browser_console`, `browser_network`, `browser_url`, `browser_status`).
- Auto-configuration of the MCP server in `~/.claude.json` on activation so Claude Code picks it up without manual setup.
- Multi-window support: each VS Code window registers its port under `~/.integrated-browser-mcp/instances/`, and the MCP server routes requests to the window whose workspace best matches Claude Code's working directory. `BROWSER_BRIDGE_PORT` can override the routing.
- Circular buffers (200 entries) for `Runtime.consoleAPICalled` and network events to power `/console` and `/network`.
- Status bar item showing connection state, with a visible warning background when disconnected.
- `🔴` prefix on the automated browser tab title so it is easy to tell which tab is driven by the bridge.
- Optional external Chrome mode (`browserBridge.browserType: "chrome"`) for situations where the integrated browser's CDP behaviour is unreliable.
- Commands: `Browser Bridge: Start`, `Browser Bridge: Stop`, `Browser Bridge: Show Status`.
- Settings: `browserBridge.httpPort`, `browserBridge.autoStart`, `browserBridge.browserType`.
