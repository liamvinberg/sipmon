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

### npm

```bash
npm install -g sipmon
```

### Bootstrap script

```bash
curl -fsSL https://raw.githubusercontent.com/liamvinberg/sipmon/main/install.sh | bash
```

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

1. Validate and package locally:

```bash
bun run release:prep
```

2. Publish to npm:

```bash
npm publish
```

3. Update Homebrew formula in your tap:

```bash
./scripts/update-homebrew-formula.sh <version> ~/personal/projects/homebrew-tap
```

4. Commit and push tap changes:

```bash
cd ~/personal/projects/homebrew-tap
git add Formula/sipmon.rb
git commit -m "feat: add sipmon formula v<version>"
git push
```
