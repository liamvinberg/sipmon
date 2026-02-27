# AGENTS

## Versioning workflow

Use the semver bump script before creating a release.

```bash
bun run version:patch
# or: bun run version:minor
# or: bun run version:major
```

What it does:
- Updates `package.json` version
- Regenerates `bun.lock` with `bun install --lockfile-only`

Optional explicit version set:

```bash
bun run version:bump -- --set 1.2.3
```

After bumping, continue with the normal release flow from `README.md`.

## Release automation

Releases are automated via GitHub Actions using `.github/workflows/release.yml`.

- It does **not** run on every push to `main`.
- It runs only when you push a semver tag like `v1.2.3`, or when manually triggered with `workflow_dispatch`.
- The workflow validates `package.json` version matches the release tag.
- It builds the binary artifact and creates/updates the GitHub Release.
- If `HOMEBREW_TAP_PUSH_TOKEN` is configured in repository secrets, it also updates `liamvinberg/homebrew-tap` automatically.

Expected release usage:

```bash
bun run version:patch
git add package.json bun.lock
git commit -m "chore: bump version to <version>"
git push

git tag "v<version>"
git push origin "v<version>"
```
