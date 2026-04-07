# VS Code Browser Bridge

Exposes VS Code's integrated browser to external agents (Claude Code, scripts, curl) via a local HTTP API and MCP server.

## Features

- HTTP API on `localhost:3788` for browser automation (navigate, eval, click, type, screenshot, etc.)
- MCP server auto-configured for Claude Code
- Connects to VS Code's built-in Chromium browser with your session cookies and localhost routing

## Extension Settings

- `browserBridge.httpPort`: Port for the local HTTP API server (default: 3788)
- `browserBridge.autoStart`: Automatically start the bridge when VS Code opens (default: true)
