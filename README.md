# sipmon

Terminal usage monitor and account switcher for AI providers.

`sipmon` is designed as a standalone provider dashboard. Right now it reads OpenAI auth snapshots from the OpenCode auth layout, but the codebase is adapter-based so additional providers and login flows can be added later.

## Current capabilities

- Account overview with aligned, color-coded remaining bars
- Fast active-account switching
- Save current auth to snapshot (auto-name from email/account)
- Rename and delete snapshots from the TUI
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

### npm (advanced)

`npm` distribution is source-based and currently expects Bun at runtime.

```bash
npm install -g sipmon
```

## Runtime requirements

- Homebrew or `install.sh` install: no Bun required for end users
- npm install: Bun required at runtime

## Run

```bash
sipmon
```

## Controls

- `j` / `k` or arrow keys: move selection
- `s` or `Enter`: switch active auth to selected snapshot
- `a`: save current active auth (auto-name from email/account)
- `r`: rename selected snapshot
- `d`: delete selected snapshot (with confirmation)
- `u`: refresh usage
- `q`: quit

## Environment overrides

- `OPENCODE_AUTH_FILE`
- `OPENCODE_USAGE_PROFILES_DIR`
- `OPENCODE_OPENAI_PROFILES_DIR`

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

4. Publish to npm (optional):

```bash
npm publish
```

5. Update Homebrew formula in your tap:

```bash
./scripts/update-homebrew-formula.sh <version> ~/personal/projects/homebrew-tap
```

6. Commit and push tap changes:

```bash
cd ~/personal/projects/homebrew-tap
git add Formula/sipmon.rb
git commit -m "feat: add sipmon formula v<version>"
git push
```
