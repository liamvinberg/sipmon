# opencode-usage-tui

Provider-oriented usage dashboard and account switcher for OpenCode auth profiles.

Current provider support:
- OpenAI / Codex

Planned provider support:
- Anthropic and others via additional adapters in `src/providers`.

## What it does

- Reads OpenCode auth from `~/.local/share/opencode/auth.json`.
- Reads saved OpenAI account snapshots from `~/.local/share/opencode/profiles/openai`.
- Shows an overview per account for:
  - Primary window remaining (5-hour window)
  - Secondary window remaining (weekly window)
  - Code review window
  - Codex-specific additional window (when present)
- Renders each window as a filled ASCII bar for fast visual scanning.
- Marks the active account.
- Lets you switch active auth quickly from the TUI.
- Lets you save the current active auth into a snapshot (defaults to email-based name).
- Shows when the active auth is unsaved.
- If active auth matches a saved snapshot, it appears once (no duplicate active row).
- Codex/code-review rows are shown only when the API reports them; unavailable rows are explicitly marked.

## Setup

1. Save one or more OpenAI snapshots with your script:

```bash
opencode-openai-profile save work
opencode-openai-profile save personal
```

2. Install dependencies:

```bash
bun install
```

3. Run:

```bash
bun run start
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
