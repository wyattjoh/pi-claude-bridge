# Releasing

This package publishes from GitHub Actions with npm trusted publishing. The
workflow filename and environment are part of npm's trust policy and must remain
`publish.yml` and `npm`.

## One-time setup

1. Create `wyattjoh/pi-claude-bridge` as a public GitHub repository and push the
   `main` branch.
2. Enable GitHub private vulnerability reporting.
3. Create a GitHub environment named `npm`. Add a required reviewer if release
   approval should be enforced.
4. Run `bun run release:check` from a clean checkout.
5. Bootstrap the npm package because npm only allows trusted publishing to be
   configured for an existing package. Publish a temporary `0.0.0` package from
   an isolated directory:

   ```sh
   npm login
   tmp="$(mktemp -d)"
   npm pack --pack-destination "$tmp"
   tar -xzf "$tmp"/wyattjoh-pi-claude-bridge-*.tgz -C "$tmp"
   npm pkg set version=0.0.0 --prefix "$tmp/package"
   npm publish "$tmp/package" --access public --ignore-scripts
   rm -rf "$tmp"
   ```

6. In the npm package settings, add a GitHub Actions trusted publisher with
   these exact values:

   | Field                | Value              |
   | -------------------- | ------------------ |
   | Organization or user | `wyattjoh`         |
   | Repository           | `pi-claude-bridge` |
   | Workflow filename    | `publish.yml`      |
   | Environment          | `npm`              |
   | Allowed action       | `npm publish`      |

7. Require two-factor authentication and disallow token-based publishing after
   confirming the trusted publisher works.

The bootstrap version is intentionally not a GitHub release. The first public
release is `0.1.0` and is published through the trusted workflow with npm
provenance.

## Publishing a release

1. Update `version` in `package.json` and `bun.lock`.
2. Move the relevant entries in `CHANGELOG.md` from `Unreleased` to the new
   version and date.
3. Run `bun install --frozen-lockfile` and `bun run release:check`.
4. Merge the release commit into `main`.
5. Create a non-prerelease GitHub Release tagged `v<package-version>` from the
   release commit.
6. Confirm the `Publish to npm` workflow succeeds.
7. Confirm the npm version, provenance badge, tarball contents, and Pi install:

   ```sh
   npm view @wyattjoh/pi-claude-bridge version
   pi -e npm:@wyattjoh/pi-claude-bridge --bridge
   ```

The workflow rejects a tag that does not exactly match the version in
`package.json`. GitHub prereleases are not published to npm by this workflow.
