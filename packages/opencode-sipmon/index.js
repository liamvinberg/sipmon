import { spawn } from "node:child_process"

const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_COOLDOWN_MS = 90_000
const UNKNOWN_SESSION_ID = "__unknown_session__"

const attemptState = new Map()

function parseInteger(value, fallback) {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parseBoolean(value, fallback) {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return fallback
}

function parseModelSpec(spec) {
  const trimmed = spec.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return null
  const providerID = trimmed.slice(0, slash).trim()
  const modelID = trimmed.slice(slash + 1).trim()
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

function parseModelList(value) {
  if (!value) return []
  return value
    .split(",")
    .map((item) => parseModelSpec(item))
    .filter((item) => item !== null)
}

function parseProviderList(value) {
  if (!value) return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function escapeAppleScript(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function notifyWithDefaultCommand(title, message) {
  if (process.platform === "darwin") {
    const script = `display notification \"${escapeAppleScript(message)}\" with title \"${escapeAppleScript(title)}\"`
    spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref()
    return
  }

  if (process.platform === "linux") {
    spawn("notify-send", [title, message], { detached: true, stdio: "ignore" }).unref()
    return
  }

  if (process.platform === "win32") {
    const escapedTitle = title.replace(/'/g, "''")
    const escapedMessage = message.replace(/'/g, "''")
    const command = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${escapedMessage}','${escapedTitle}')`
    spawn("powershell", ["-NoProfile", "-Command", command], { detached: true, stdio: "ignore" }).unref()
  }
}

function notify(title, message) {
  const custom = process.env.OPENCODE_FAILOVER_NOTIFY_COMMAND
  if (custom && custom.trim()) {
    const command = custom
      .replaceAll("{title}", title)
      .replaceAll("{message}", message)
      .replaceAll("{json}", JSON.stringify({ title, message }))
    spawn("sh", ["-lc", command], { detached: true, stdio: "ignore" }).unref()
    return
  }

  notifyWithDefaultCommand(title, message)
}

function extractErrorDetails(error) {
  if (!error || typeof error !== "object") return ""
  const maybeData = error.data
  const dataMessage =
    maybeData && typeof maybeData === "object" && typeof maybeData.message === "string" ? maybeData.message : ""
  const responseBody =
    maybeData && typeof maybeData === "object" && typeof maybeData.responseBody === "string" ? maybeData.responseBody : ""
  const name = typeof error.name === "string" ? error.name : ""
  return [name, dataMessage, responseBody].filter(Boolean).join("\n")
}

function isUsageLimitError(error) {
  const details = extractErrorDetails(error)
  if (!details) return false
  return [
    /insufficient_quota/i,
    /usage_not_included/i,
    /quota exceeded/i,
    /quota\b/i,
    /usage limit reached/i,
    /rate limit/i,
    /too many requests/i,
    /status\s*code\s*429/i,
    /subscription quota exceeded/i,
  ].some((pattern) => pattern.test(details))
}

function getAttemptState(sessionID) {
  const key = sessionID || UNKNOWN_SESSION_ID
  const existing = attemptState.get(key)
  if (existing) return { key, state: existing }
  const created = {
    attempts: 0,
    lastAttemptAt: 0,
    inFlight: false,
  }
  attemptState.set(key, created)
  return { key, state: created }
}

function failoverModels(configModelID) {
  const explicit = parseModelList(process.env.OPENCODE_FAILOVER_MODELS)
  if (explicit.length > 0) return explicit

  const fallbackProviders = parseProviderList(process.env.OPENCODE_FAILOVER_PROVIDERS)
  if (fallbackProviders.length > 0 && configModelID) {
    return fallbackProviders.map((providerID) => ({ providerID, modelID: configModelID }))
  }

  return []
}

function readConfigModelID(config) {
  if (!config || typeof config !== "object") return null
  if (typeof config.model !== "string") return null
  const parsed = parseModelSpec(config.model)
  return parsed ? parsed.modelID : null
}

function createPromptPart(reason, model) {
  return {
    type: "text",
    text: [
      "Continue from the latest session state.",
      `The previous model request failed due to usage/rate limits: ${reason}`,
      `Use fallback model ${model.providerID}/${model.modelID} and continue without repeating completed work.`,
    ].join(" "),
  }
}

export async function OpenCodeSipmonFailoverPlugin(input) {
  let configuredModelID = null

  return {
    config: async (config) => {
      configuredModelID = readConfigModelID(config)
    },
    event: async ({ event }) => {
      if (event.type !== "session.error") return

      const enabled = parseBoolean(process.env.OPENCODE_FAILOVER_ENABLED, true)
      if (!enabled) return

      const sessionID = event.properties?.sessionID
      const error = event.properties?.error
      if (!isUsageLimitError(error)) return
      if (!sessionID) {
        notify("OpenCode failover", "Usage-limit error detected but no session ID was provided.")
        return
      }

      const models = failoverModels(configuredModelID)
      if (models.length === 0) {
        notify(
          "OpenCode failover",
          "Usage-limit error detected but no fallback models configured (set OPENCODE_FAILOVER_MODELS).",
        )
        return
      }

      const maxAttempts = Math.min(parseInteger(process.env.OPENCODE_FAILOVER_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS), models.length)
      const cooldownMs = parseInteger(process.env.OPENCODE_FAILOVER_COOLDOWN_MS, DEFAULT_COOLDOWN_MS)
      const { state } = getAttemptState(sessionID)

      if (state.inFlight) return
      if (Date.now() - state.lastAttemptAt < cooldownMs) return
      if (state.attempts >= maxAttempts) {
        notify("OpenCode failover", `Failover attempts exhausted for session ${sessionID}.`)
        return
      }

      const nextModel = models[state.attempts]
      if (!nextModel) return

      state.inFlight = true
      state.lastAttemptAt = Date.now()
      state.attempts += 1

      try {
        const reason = extractErrorDetails(error).replace(/\s+/g, " ").slice(0, 220)
        notify(
          "OpenCode failover",
          `Retrying session ${sessionID} on ${nextModel.providerID}/${nextModel.modelID} (attempt ${state.attempts}/${maxAttempts}).`,
        )

        await input.client.session.prompt({
          path: { id: sessionID },
          body: {
            model: nextModel,
            parts: [createPromptPart(reason || "usage limit reached", nextModel)],
          },
        })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        notify("OpenCode failover", `Failover retry failed for session ${sessionID}: ${message}`)
      } finally {
        state.inFlight = false
      }
    },
  }
}

export default OpenCodeSipmonFailoverPlugin
