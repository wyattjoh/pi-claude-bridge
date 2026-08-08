# @wyattjoh/pi-bridge

A [Pi](https://pi.dev/) extension that makes a Pi session addressable from
Claude Code's cross-session peer messaging tools.

The extension is opt-in. It always registers the CLI flag Pi needs to parse,
but it registers peer tools and starts its Unix socket only when the session is
started with `--bridge`.

## Install

```sh
pi install npm:@wyattjoh/pi-bridge
```

## Usage

Start Pi with Claude Code peer messaging enabled:

```sh
pi --bridge
```

When enabled, the package registers `list_agents` and `send_message`, writes a
Claude-compatible session record under `~/.claude/sessions/`, and serves peer
messages over a Unix socket. Without `--bridge`, it does not inspect
session records or create any files, sockets, or tools.

## Development

```sh
bun install
bun run check
bunx lefthook install
```

The pre-commit hook checks staged JavaScript and TypeScript files with Oxfmt and Oxlint. Use `git commit --no-verify` to bypass it in an emergency, or `bunx lefthook uninstall` to remove the installed hook.

To try the local extension without installing the package:

```sh
pi -e ./src/index.ts --bridge
```
