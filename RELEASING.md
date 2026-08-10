# Releasing

Release Please owns version bumps, changelog entries, tags, and GitHub Releases.
The same GitHub Actions workflow publishes completed releases to npm through
trusted publishing. The workflow filename and environment are part of npm's
trust policy and must remain `publish.yml` and `npm`.

## One-time setup

1. Create `wyattjoh/pi-claude-bridge` as a public GitHub repository.
2. In Settings > Actions > General, allow GitHub Actions to create and approve
   pull requests.
3. Enable GitHub private vulnerability reporting.
4. Create a GitHub environment named `npm`. Add a required reviewer if release
   approval should be enforced.
5. Push `main`. The Release Please workflow creates the initial `0.1.0` release
   pull request from the repository's Conventional Commit history.
6. Bootstrap the npm package because npm only allows trusted publishing to be
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

7. In the npm package settings, add a GitHub Actions trusted publisher with
   these exact values:

   | Field                | Value              |
   | -------------------- | ------------------ |
   | Organization or user | `wyattjoh`         |
   | Repository           | `pi-claude-bridge` |
   | Workflow filename    | `publish.yml`      |
   | Environment          | `npm`              |
   | Allowed action       | `npm publish`      |

8. Require two-factor authentication and disallow token-based publishing after
   confirming the trusted publisher works.
9. Review the initial release pull request. Confirm that it proposes `0.1.0`,
   contains the expected history, and uses the `v0.1.0` tag before merging it.

The bootstrap version is intentionally not a GitHub release. Merging the first
Release Please pull request creates the `0.1.0` GitHub Release and publishes the
real package with npm provenance.

## Publishing releases

Use Conventional Commits on `main`:

- `fix:` and `perf:` produce a patch release.
- `feat:` produces a minor release.
- `feat!:` or a `BREAKING CHANGE:` footer produces a minor release before 1.0.0
  and a major release after 1.0.0.
- Other commit types do not trigger a release by default.

Release Please opens or updates a release pull request after qualifying commits
reach `main`. That pull request updates `package.json`, `CHANGELOG.md`, and
`.release-please-manifest.json`. Do not edit those release values manually.

Before merging the release pull request:

1. Review the proposed version and changelog.
2. Confirm CI or run `bun run release:check` locally.
3. Merge the release pull request.
4. Confirm the `Release Please` workflow creates the `v<package-version>` GitHub
   Release and its `Publish to npm` job succeeds.
5. Confirm the npm version, provenance badge, tarball contents, and Pi install:

   ```sh
   npm view @wyattjoh/pi-claude-bridge version
   pi -e npm:@wyattjoh/pi-claude-bridge --bridge
   ```

The publish job checks out the generated release tag, repeats the complete
release gate, and rejects a tag that does not exactly match `package.json`.
