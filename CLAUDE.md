# Package Instructions

## Purpose

This repository owns `@wyattjoh/pi-claude-bridge`, a Pi extension that exposes an
opt-in Pi session to Claude Code peer messaging.

## Development

- Preserve the opt-in boundary: peer discovery, tools, sockets, session records, and stale-record cleanup start only after `--bridge` is enabled.
- Test lifecycle behavior through temporary configuration and runtime directories, never the developer's real home or Claude state.
- Treat `bun run release:check` as the completion gate.

## Release

Read `RELEASING.md` before publishing. Release Please owns `package.json` versions, `.release-please-manifest.json`, changelog entries, tags, and GitHub Releases. Keep `.github/workflows/publish.yml` stable because npm trusted publishing binds to the exact workflow filename and `npm` environment.

## Effect Design

- Use stable Effect 3 only. Keep `effect` as a direct runtime dependency and do not introduce Effect 4 beta APIs.
- Keep one scoped `Bridge` service and one managed runtime per enabled Pi session. The scope owns startup rollback, connections, server shutdown, and proven-owned record cleanup.
- Normalize foreign Node failures into tagged bridge failures at the platform boundary. Pi callbacks render expected failures without unhandled rejections.
- Keep record validation, identity comparison, target selection, reference formatting, and protocol decisions deterministic. Put filesystem, Unix-socket, clock, identifier, process, and environment access behind `src/platform.ts`.
- Preserve the opt-in boundary. Do not construct a runtime, inspect records, or access the platform when `--bridge` is disabled.
