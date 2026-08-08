# Package Instructions

## Purpose

This repository owns `@wyattjoh/pi-bridge`, a Pi extension that exposes an
opt-in Pi session to Claude Code peer messaging.

## Development

- Preserve the opt-in boundary: peer discovery, tools, sockets, session records, and stale-record cleanup start only after `--bridge` is enabled.
- Test lifecycle behavior through temporary configuration and runtime directories, never the developer's real home or Claude state.
- Treat the standard project check and a package dry run as completion gates.
