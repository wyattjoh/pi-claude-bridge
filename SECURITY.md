# Security Policy

## Supported versions

Security fixes are provided for the latest published minor version.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/wyattjoh/pi-claude-bridge/security/advisories/new)
and include:

- the affected version
- a description of the impact
- reproduction steps or a proof of concept
- any suggested mitigation

You should receive an acknowledgment within seven days. Please allow time to
investigate and prepare a fix before publicly disclosing the issue.

## Security boundary

The bridge exposes a local Unix socket to processes running as the same user. It
does not provide network transport or authentication for mutually untrusted
local processes. The bridge remains inactive unless Pi starts with `--bridge`.
