# opencode-sipmon

OpenCode plugin that listens for usage-limit events and automatically switches the active OpenAI account using sipmon snapshots.

When a rate-limit happens, it picks the best available sipmon OpenAI snapshot and writes that auth into OpenCode auth. OpenCode's own retry loop then continues naturally on the switched account.

## Install

```bash
npm install opencode-sipmon
```

## Add to OpenCode config

`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-sipmon"]
}
```

### Local dev plugin path (before publish)

If you want to test this repo copy directly, use a `file://` entry that points to the plugin file:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///Users/liamvinberg/personal/projects/sipmon/packages/opencode-sipmon/index.js"
  ]
}
```

After publishing to npm, switch back to:

```json
{
  "plugin": ["opencode-sipmon"]
}
```

## Required setup

No failover env vars are required.

The plugin uses existing sipmon/OpenCode paths:

- sipmon snapshots: `$SIPMON_OPENAI_PROFILES_DIR` or `~/.local/share/sipmon/profiles/openai`
- OpenCode auth: `$OPENCODE_AUTH_FILE` or `~/.local/share/opencode/auth.json`

As long as sipmon snapshots exist, switching works automatically.

## Notifications

Default local notification behavior:

- macOS: `osascript`
- Linux: `notify-send`
- Windows: PowerShell message box

Optional override: `OPENCODE_FAILOVER_NOTIFY_COMMAND`

Optional log path override: `OPENCODE_FAILOVER_LOG_FILE`

## Safety guards

- In-flight lock per session
- Cooldown per session (45s)
- Maximum attempts per session (3)

These are required because OpenCode event hooks are dispatched without awaiting plugin completion.

## Selection rules

For each sipmon snapshot (except current and already-tried ones), plugin:

- refreshes token if needed
- fetches usage from OpenAI usage API
- computes usable status with strict rule: both 5h and 7d must be > 0
- prefers Codex windows when available
- selects the highest-scoring usable snapshot

If no usable snapshot exists, no switch is performed.

## Verify it loaded

Check the log file (default: `~/.local/state/sipmon/opencode-sipmon.log`) for lines like:

- `plugin_initialized`
- `session_retry_status_received`
- `session_error_received`
- `snapshot_candidates_evaluated`
- `active_auth_switched`
- `switch_applied`
