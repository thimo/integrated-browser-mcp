# Releasing

How to cut a release of `integrated-browser-mcp`.

## Versioning (SemVer)

- **Patch** `0.5.x` — bug fixes, no surface change
- **Minor** `0.x.0` — new MCP tools or HTTP endpoints, new options on existing ones
- **Major** `x.0.0` — breaking changes to the MCP tool surface or HTTP API

## One-time setup

- VS Code Marketplace personal access token, stored locally so `vsce publish` can authenticate. See [the vsce docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token).
- `gh` CLI logged in (`gh auth status`).

## Automated release

Write release notes under `## Unreleased` in `CHANGELOG.md` first — the script bails if that section is missing or empty. Lean verbose; explain the *why* of each change, not just the *what*.

Then:

```bash
npm run release -- 0.5.2
```

That single command runs the full flow: pre-flight checks, version bump, CHANGELOG date-stamp, commit, tag, `.vsix` build, smoke-test pause, marketplace publish, `git push`, GitHub release with the `.vsix` attached.

The smoke-test pause is the last reversible point — once you confirm, the script publishes externally.

### Flags

- `--skip-smoke-test` — skip the manual confirmation prompt (CI / re-run scenarios)
- `--no-marketplace` — skip the marketplace publish step (useful when iterating on a release that's already up)
- `--dry-run` — print every command without executing
- `--clean-install` — run `npm ci` during pre-flight (slower; use after dependency changes)

### Rolling back before push

If the smoke test fails, abort at the prompt. Local state is recoverable:

```bash
git tag -d v0.5.2
git reset --hard HEAD~1
trash integrated-browser-mcp-0.5.2.vsix
```

### Rolling back after push

You can't unpublish from the marketplace (only deprecate). For GitHub:

```bash
gh release delete v0.5.2
git push origin :refs/tags/v0.5.2
git tag -d v0.5.2
```

Don't `git reset` published commits — push a follow-up fix instead.

## Manual flow (reference)

The script just automates this. Useful when the script breaks or you need to do partial work.

```bash
git switch main
git pull --ff-only
npm run check-types
npm run compile
```

1. `package.json` → `"version"` — single source of truth. The MCP server reads this at build time via esbuild's `define` (see `esbuild.js`).
2. `CHANGELOG.md` → `## Unreleased` becomes `## [X.Y.Z] — YYYY-MM-DD`

```bash
git add package.json CHANGELOG.md
git commit -m "Release X.Y.Z"
git tag vX.Y.Z
npx vsce package --out integrated-browser-mcp-X.Y.Z.vsix
```

Smoke test:

```bash
code --install-extension integrated-browser-mcp-X.Y.Z.vsix --force
```

Restart Claude Code (the MCP child process is captured at session start; reloading VS Code or reinstalling the extension doesn't refresh it). Run through the new features end-to-end.

```bash
npm run publish:marketplace -- --packagePath integrated-browser-mcp-X.Y.Z.vsix
git push origin main
git push origin vX.Y.Z

gh release create vX.Y.Z integrated-browser-mcp-X.Y.Z.vsix \
  --title "vX.Y.Z" \
  --notes-file <(awk '/^## \[X\.Y\.Z\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md)
```

The `awk` pulls the just-released CHANGELOG section as the release body. Replace `X\.Y\.Z` with the actual version (escaping the dots). The release must include the `.vsix` so users who don't use the marketplace (or want to pin a version) can install it manually.

## Verify

- Marketplace listing shows the new version: <https://marketplace.visualstudio.com/items?itemName=thimo.integrated-browser-mcp>
- GitHub release is "Latest": <https://github.com/thimo/integrated-browser-mcp/releases>
- README badges render correctly on the repo home

## Troubleshooting

- **`vsce publish` says "Extensions using unallowed proposed API"** — bare `vsce publish` instead of `npm run publish:marketplace`. The script passes the required `--allow-proposed-apis browser` flag.
- **VS Code Extension Development Host doesn't pick up new code** — `Developer: Reload Window`, or restart F5.
- **Claude Code doesn't see new MCP tools** — full Claude Code restart (`/exit` + relaunch). The MCP child process holds the registered tool set in memory; reinstalling the extension on disk doesn't replace an already-running child.
- **Tag already exists locally but you need to recreate it** — `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z` then re-tag. Don't do this once a release is out — it breaks anyone who downloaded the tag.

## Why the manual smoke test step is non-negotiable

The Chromium and VS Code APIs this extension leans on (`Page.setDeviceMetricsOverride`, `BrowserTab` proposed API, the `vscode-js-debug` CDP proxy, `Page.setDownloadBehavior`) are all moving targets. A diff that compiles and packages cleanly can still be a no-op at runtime if the underlying API changed shape. Treat compile + package as evidence of nothing about runtime behaviour.
