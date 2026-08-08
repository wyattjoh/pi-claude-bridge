# Package Instructions

## Purpose

This repository owns `@wyattjoh/pi-bridge`, a Pi extension that exposes an
opt-in Pi session to Claude Code peer messaging.

## Development

- Use Bun for dependency installation and tests.
- Keep the Pi package entrypoint at `src/index.ts` and its focused test beside it.
- Preserve the opt-in boundary: peer discovery, tools, sockets, and session records start only after `--bridge` is enabled.
- Run `bun run check` before considering changes complete.
