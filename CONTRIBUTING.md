# Contributing

Thanks for helping improve `@wyattjoh/pi-claude-bridge`.

## Before opening an issue

- Search existing issues and confirm the behavior is not already documented.
- For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
- Include your Pi, Node.js, operating system, and package versions in bug reports.

## Development

This project uses Bun and requires Node.js 22.19.0 or newer.

```sh
git clone https://github.com/wyattjoh/pi-claude-bridge.git
cd pi-claude-bridge
bun install
bunx lefthook install
bun run release:check
```

To exercise the extension locally without installing it:

```sh
pi -e ./src/index.ts --bridge
```

Tests must use temporary configuration and runtime directories. They must not
read or modify the developer's real Claude Code session records.

## Pull requests

- Keep the bridge fully inactive unless `--bridge` is present.
- Add or update tests for behavior changes.
- Run `bun run release:check` before submitting.
- Use a Conventional Commit title, such as `fix: preserve replacement records`.
- Keep each pull request focused and explain both what changed and why.

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
