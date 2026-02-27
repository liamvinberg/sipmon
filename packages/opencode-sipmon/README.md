# opencode-sipmon

OpenCode plugin that listens for `session.error` events, detects usage-limit/rate-limit failures, retries the same session on fallback model aliases, and sends a local notification from CLI context.

## Why alias-based failover

OpenCode auth storage is keyed by provider ID. That means one credential record per provider ID, so account failover is safest when you configure provider aliases (for example `openai-primary`, `openai-backup`) and authenticate each alias separately.

## Install

```bash
npm install opencode-sipmon
```

## Add to OpenCode config

`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-sipmon"],
  "provider": {
    "openai-primary": {
      "npm": "@ai-sdk/openai",
      "options": {
        "baseURL": "https://api.openai.com/v1"
      }
    },
    "openai-backup": {
      "npm": "@ai-sdk/openai",
      "options": {
        "baseURL": "https://api.openai.com/v1"
      }
    }
  }
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

## Environment configuration

The plugin is configured by environment variables so it can stay drop-in from `opencode.json`.

- `OPENCODE_FAILOVER_MODELS` (recommended): comma-separated `<provider>/<model>` list in failover order.
- `OPENCODE_FAILOVER_PROVIDERS`: comma-separated provider alias list; used with `config.model` model ID.
- `OPENCODE_FAILOVER_MAX_ATTEMPTS`: max retries per session (default `2`).
- `OPENCODE_FAILOVER_COOLDOWN_MS`: minimum time between retries for the same session (default `90000`).
- `OPENCODE_FAILOVER_ENABLED`: `true|false` (default `true`).
- `OPENCODE_FAILOVER_NOTIFY_COMMAND`: optional custom shell command with placeholders `{title}`, `{message}`, `{json}`.

Example:

```bash
export OPENCODE_FAILOVER_MODELS="openai-backup/gpt-5.3-codex,openai-third/gpt-5.3-codex"
export OPENCODE_FAILOVER_MAX_ATTEMPTS="2"
export OPENCODE_FAILOVER_COOLDOWN_MS="90000"
```

## Notifications

Default local notification behavior:

- macOS: `osascript`
- Linux: `notify-send`
- Windows: PowerShell message box

You can override with `OPENCODE_FAILOVER_NOTIFY_COMMAND`.

## Safety guards

- In-flight lock per session
- Cooldown per session
- Maximum attempts per session

These are required because OpenCode event hooks are dispatched without awaiting plugin completion.
