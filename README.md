# @wyattjoh/pi-cc-socket

A [Pi](https://pi.dev/) extension that makes a Pi session addressable from
Claude Code's cross-session peer messaging tools.

The extension is opt-in. It always registers the CLI flags Pi needs to parse,
but it registers peer tools and starts its Unix socket only when the session is
started with `--claude-peer`.

## Install

```sh
pi install npm:@wyattjoh/pi-cc-socket
```

## Usage

Start Pi with Claude Code peer messaging enabled:

```sh
pi --claude-peer
```

Optionally set the name advertised to other sessions:

```sh
pi --claude-peer --cc-name my-pi
```

When enabled, the package registers `list_agents` and `send_message`, writes a
Claude-compatible session record under `~/.claude/sessions/`, and serves peer
messages over a Unix socket. Without `--claude-peer`, it does not inspect
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
pi -e ./src/index.ts --claude-peer
```
