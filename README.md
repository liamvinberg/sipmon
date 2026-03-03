# sipmon

Terminal usage monitor and account switcher for AI providers.

`sipmon` is designed as a standalone provider dashboard with provider-owned auth storage and OAuth login flow.

## OpenCode plugin package (not tested that much)

This repo also contains `opencode-sipmon`, a publishable OpenCode plugin package for usage-limit failover and local notifications:

- package path: `packages/opencode-sipmon`
- config example: `examples/opencode/opencode.json`

## Current capabilities

- Account overview with aligned, color-coded remaining bars
- OAuth login handled directly by sipmon (`a`)
- Fast active-account switching
- Auto-save snapshot when OAuth login succeeds
- Delete snapshots from the TUI
- OpenAI/Codex usage parsing including primary, weekly, and extra limit windows

## Install

### Homebrew (recommended)

```bash
brew tap liamvinberg/tap
brew install liamvinberg/tap/sipmon
```

### curl bootstrap (no Homebrew)

```bash
curl -fsSL https://raw.githubusercontent.com/liamvinberg/sipmon/main/install.sh | bash
```

## Runtime requirements

- Homebrew or `install.sh` install: no Bun required for end users

## Run

```bash
sipmon
```

## Controls

- `j` / `k` or arrow keys: move selection
- `a`: login via provider OAuth flow (OpenAI/Codex)
- `s` or `Enter`: switch active auth to selected snapshot
- `d`: delete selected snapshot (with confirmation)
- `u`: refresh usage
- `q`: quit

## Environment overrides

- `SIPMON_DATA_DIR`
- `SIPMON_AUTH_FILE`
- `SIPMON_PROFILES_DIR`
- `SIPMON_OPENAI_PROFILES_DIR`
- `SIPMON_REPLICATION_TARGETS` (default: `opencode`)
- `OPENCODE_AUTH_FILE` (replication target path)

## Local development

```bash
bun install
bun run check
bun run dev
```

## Release flow

1. Bump version (updates `package.json` and `bun.lock`):

```bash
bun run version:patch
# or: bun run version:minor
# or: bun run version:major
```

2. Validate and package locally:

```bash
bun run release:prep
```

3. Create release artifact and publish GitHub release:

```bash
bun run build:artifact
gh release create "v<version>" "dist/sipmon-<version>-darwin-arm64.tar.gz" --title "v<version>" --notes "..."
```

4. Update Homebrew formula in your tap:

```bash
./scripts/update-homebrew-formula.sh <version> ~/personal/projects/homebrew-tap
```

5. Commit and push tap changes:

```bash
cd ~/personal/projects/homebrew-tap
git add Formula/sipmon.rb
git commit -m "feat: add sipmon formula v<version>"
git push
```
