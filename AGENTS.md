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
