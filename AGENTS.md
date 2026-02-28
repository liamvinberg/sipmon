# AGENTS

## Project overview

sipmon is a terminal UI (TUI) usage monitor and account switcher for AI providers. It displays usage bars, handles OAuth login, and manages profile snapshots. Currently supports OpenAI/Codex.

The repo also contains `packages/opencode-sipmon`, a publishable OpenCode plugin for usage-limit failover and local notifications.

## Tech stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode, ES2022 target, Bundler module resolution)
- **TUI framework**: `@opentui/core` + `@opentui/react` (React 19, JSX with `@opentui/react` import source)
- **Build**: `bunx tsc --outDir dist`, binary via `bun build --compile`
- **Distribution**: Homebrew tap, npm, curl install script

## Project structure

```
src/
  cli.ts              Entry point, version/help handling, delegates to main
  main.tsx            TUI app (React component tree rendered via @opentui)
  providers/
    types.ts          Core types: UsageWindow, ProfileUsage, ProviderProfile, ProviderAdapter
    index.ts          Provider registry (currently exports openAIProvider only)
    openai.ts         OpenAI provider: OAuth PKCE login, profile/snapshot management, usage API
packages/
  opencode-sipmon/    OpenCode plugin package (separate publishable package)
scripts/
  bump-version.mjs    Semver bump (updates package.json + bun.lock)
  build-binary.sh     Bun compile to standalone binary
  build-release-artifact.sh  Tar.gz packaging for GitHub releases
  update-homebrew-formula.sh Homebrew tap formula updater
.github/
  workflows/
    release.yml       CI: build + GitHub release + Homebrew tap update on tag push
```

## Architecture

### Provider adapter pattern

All provider logic lives behind `ProviderAdapter` (see `src/providers/types.ts`). Each provider implements: `loginWithOAuth`, `listProfiles`, `switchToProfile`, `saveCurrentProfile`, `renameProfile`, `deleteProfile`, `fetchUsage`.

The app consumes providers generically via `src/providers/index.ts`. Adding a new provider means implementing the adapter interface and registering it in the providers array.

### Auth storage

- sipmon auth: `~/.local/share/sipmon/auth.json`
- Profile snapshots: `~/.local/share/sipmon/profiles/openai/<name>.json`
- Auth replication: writes to opencode auth file when `SIPMON_REPLICATION_TARGETS` includes "opencode"
- All JSON writes are atomic (write tmp + rename) with 0600 permissions

### TUI rendering

`main.tsx` is a single React component (`App`) rendered via `@opentui/core`'s CLI renderer. State is managed with React hooks. Keyboard input drives all interactions (no mouse support). The app auto-refreshes usage every 60 seconds.

## Key conventions

- Flat module structure, no deep nesting
- Types co-located in `types.ts` per module
- No external state management library; React hooks only
- JSON helper functions (`asObject`, `asString`, `asNumber`, `asBoolean`) for safe runtime type narrowing of unknown API responses
- Error handling returns error strings in data objects rather than throwing (see `ProfileUsage.error`)
- No test framework currently configured

## Development

```bash
bun install
bun run check    # typecheck only
bun run dev      # run from source
```

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
