# @wyattjoh/pi-claude-bridge

[![CI](https://github.com/wyattjoh/pi-claude-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/wyattjoh/pi-claude-bridge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@wyattjoh/pi-claude-bridge)](https://www.npmjs.com/package/@wyattjoh/pi-claude-bridge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Pi](https://pi.dev/) extension that makes an opted-in Pi session addressable
from Claude Code's cross-session peer messaging tools.

> [!IMPORTANT]
> Pi packages run with the same system access as Pi. Review the source before
> installing third-party extensions.

## Requirements

- Pi 0.84.1 or newer is the tested baseline
- Node.js 22.19.0 or newer
- macOS or Linux with Unix domain socket support

## Install

```sh
pi install npm:@wyattjoh/pi-claude-bridge
```

Update or remove the package with Pi's package manager:

```sh
pi update npm:@wyattjoh/pi-claude-bridge
pi remove npm:@wyattjoh/pi-claude-bridge
```

## Usage

Start Pi with the bridge enabled:

```sh
pi --bridge
```

The extension always registers the CLI flag so Pi can parse it, but everything
else remains opt-in. Without `--bridge`, it does not inspect peer records,
register peer tools, create files, or open sockets.

When enabled, the extension:

- registers `list_agents` and `send_message`
- writes a Claude-compatible record under `~/.claude/sessions/`
- serves peer messages over a user-owned Unix socket
- publishes Pi's current status to compatible peers

Incoming peer frames are limited to 1,048,576 bytes. An oversized frame is
rejected with a warning while the bridge stays available for other peers.

If secure startup or record publication fails, Pi displays an error and
continues without bridge tools. Status publication failures after startup warn
once without stopping peer messaging.

At enabled startup only, the extension conservatively removes stale records
that carry its ownership marker and whose Unix socket is definitely
unreachable. It leaves native Claude Code records, uncertain probes, changed
records, and every socket path named by a stale record untouched. Peer listing
is observational and does not perform cleanup.

## Security and privacy

The bridge is local-only. It does not expose a TCP listener or add remote
authentication. Any process running as your user may be able to read the peer
record and connect to the Unix socket, so enable the bridge only in environments
you trust.

Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/wyattjoh/pi-claude-bridge/security/advisories/new).
See [SECURITY.md](SECURITY.md) for the disclosure policy.

## Development

The enabled bridge uses stable Effect 3 to own one scoped lifecycle. Its Node
platform boundary makes filesystem and Unix socket failures controllable in
tests, while record and protocol decisions remain deterministic.

```sh
bun install
bun run release:check
bunx lefthook install
```

The pre-commit hook checks staged JavaScript and TypeScript files with Oxfmt and
Oxlint. To try the local extension without installing the package:

```sh
pi -e ./src/index.ts --bridge
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and
[RELEASING.md](RELEASING.md) for the maintainer release process.

## License

[MIT](LICENSE)
