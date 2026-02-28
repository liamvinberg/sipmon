import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OPENAI_ISSUER = "https://auth.openai.com"
const OPENAI_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_COOLDOWN_MS = 45_000
const UNKNOWN_SESSION_ID = "__unknown_session__"

const attemptState = new Map()

function parseBoolean(value, fallback) {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return fallback
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value
}

function asString(value) {
  return typeof value === "string" ? value : null
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function escapeAppleScript(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function resolveLogFile() {
  if (process.env.OPENCODE_FAILOVER_LOG_FILE) return process.env.OPENCODE_FAILOVER_LOG_FILE
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(stateHome, "sipmon", "opencode-sipmon.log")
}

async function appendLog(line) {
  const filePath = resolveLogFile()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${line}\n`, "utf8")
}

function logEvent(message, details) {
  const stamp = new Date().toISOString()
  const detailText = details ? ` ${JSON.stringify(details)}` : ""
  void appendLog(`[${stamp}] ${message}${detailText}`).catch(() => {})
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
  logEvent("notify", { title, message })
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

function isUsageLimitMessage(message) {
  if (!message || typeof message !== "string") return false
  return [
    /insufficient_quota/i,
    /usage_not_included/i,
    /quota exceeded/i,
    /quota\b/i,
    /usage limit reached/i,
    /usage limit has been reached/i,
    /rate limit/i,
    /too many requests/i,
    /status\s*code\s*429/i,
  ].some((pattern) => pattern.test(message))
}

function getAttemptState(sessionID) {
  const key = sessionID || UNKNOWN_SESSION_ID
  const existing = attemptState.get(key)
  if (existing) return existing
  const created = {
    attempts: 0,
    lastAttemptAt: 0,
    inFlight: false,
    triedProfiles: new Set(),
  }
  attemptState.set(key, created)
  return created
}

function decodeJwtPayload(token) {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8")
    return asObject(JSON.parse(json))
  } catch {
    return null
  }
}

function accountIdFromPayload(payload) {
  const nested = asObject(payload["https://api.openai.com/auth"])
  const nestedID = nested ? asString(nested.chatgpt_account_id) : null
  if (nestedID) return nestedID
  const rootID = asString(payload.chatgpt_account_id)
  if (rootID) return rootID
  const organizations = payload.organizations
  if (Array.isArray(organizations) && organizations.length > 0) {
    const first = asObject(organizations[0])
    const orgID = first ? asString(first.id) : null
    if (orgID) return orgID
  }
  return null
}

function extractAccountId(auth) {
  const explicit = asString(auth.accountId)
  if (explicit) return explicit
  const access = asString(auth.access)
  if (!access) return null
  const payload = decodeJwtPayload(access)
  if (!payload) return null
  return accountIdFromPayload(payload)
}

function sameIdentity(left, right) {
  const leftRefresh = asString(left.refresh)
  const rightRefresh = asString(right.refresh)
  if (leftRefresh && rightRefresh && leftRefresh === rightRefresh) return true

  const leftAccountID = extractAccountId(left)
  const rightAccountID = extractAccountId(right)
  if (leftAccountID && rightAccountID && leftAccountID === rightAccountID) return true

  const leftAccess = asString(left.access)
  const rightAccess = asString(right.access)
  if (leftAccess && rightAccess && leftAccess === rightAccess) return true

  return false
}

function resolveDataPaths() {
  const home = os.homedir()
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share")

  const sipmonDataDir = process.env.SIPMON_DATA_DIR || path.join(dataHome, "sipmon")
  const sipmonAuthFile = process.env.SIPMON_AUTH_FILE || path.join(sipmonDataDir, "auth.json")

  const sipmonProfilesDir =
    process.env.SIPMON_OPENAI_PROFILES_DIR ||
    path.join(process.env.SIPMON_PROFILES_DIR || path.join(sipmonDataDir, "profiles"), "openai")

  const opencodeAuthFile = process.env.OPENCODE_AUTH_FILE || path.join(dataHome, "opencode", "auth.json")

  return { sipmonAuthFile, sipmonProfilesDir, opencodeAuthFile }
}

async function readJsonObject(filePath) {
  const content = await fs.readFile(filePath, "utf8")
  const parsed = JSON.parse(content)
  const object = asObject(parsed)
  return object || {}
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await fs.chmod(tmp, 0o600)
  await fs.rename(tmp, filePath)
}

async function readCurrentOpenAIAuth(opencodeAuthFile) {
  try {
    const root = await readJsonObject(opencodeAuthFile)
    return asObject(root.openai)
  } catch {
    return null
  }
}

async function shouldRefresh(auth) {
  const access = asString(auth.access)
  const expires = asNumber(auth.expires)
  if (!access) return true
  if (expires === null) return false
  return expires <= Date.now() + 30_000
}

async function refreshAuth(auth) {
  const refresh = asString(auth.refresh)
  if (!refresh) throw new Error("Missing refresh token")

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: OPENAI_OAUTH_CLIENT_ID,
  })

  const response = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })

  if (!response.ok) throw new Error(`OAuth refresh failed (${response.status})`)
  const payload = asObject(await response.json())
  if (!payload) throw new Error("OAuth refresh returned invalid payload")

  const access = asString(payload.access_token)
  if (!access) throw new Error("OAuth refresh missing access token")

  const refreshToken = asString(payload.refresh_token) || refresh
  const expiresIn = asNumber(payload.expires_in) || 3600

  return {
    ...auth,
    type: "oauth",
    access,
    refresh: refreshToken,
    expires: Date.now() + expiresIn * 1000,
  }
}

function windowRemainingPercent(window) {
  const used = asNumber(window?.used_percent)
  if (used === null) return null
  return Math.max(0, Math.min(100, 100 - used))
}

function usageWindowsFromPayload(payload) {
  const additional = payload.additional_rate_limits
  if (Array.isArray(additional)) {
    for (const item of additional) {
      const entry = asObject(item)
      if (!entry) continue
      const limitName = asString(entry.limit_name) || ""
      const meteredFeature = asString(entry.metered_feature) || ""
      if (!/codex/i.test(limitName) && !/codex/i.test(meteredFeature)) continue
      const rate = asObject(entry.rate_limit)
      if (!rate) continue
      return {
        scope: "codex",
        fiveHour: windowRemainingPercent(asObject(rate.primary_window)),
        sevenDay: windowRemainingPercent(asObject(rate.secondary_window)),
      }
    }
  }

  const rate = asObject(payload.rate_limit)
  if (!rate) return { scope: "primary", fiveHour: null, sevenDay: null }

  return {
    scope: "primary",
    fiveHour: windowRemainingPercent(asObject(rate.primary_window)),
    sevenDay: windowRemainingPercent(asObject(rate.secondary_window)),
  }
}

function usageScore(windows) {
  const five = windows.fiveHour
  const seven = windows.sevenDay
  if (five === null || seven === null) return Number.NEGATIVE_INFINITY
  if (five <= 0 || seven <= 0) return Number.NEGATIVE_INFINITY
  return Math.min(five, seven) * 1000 + five + seven
}

async function fetchUsageForAuth(auth) {
  const access = asString(auth.access)
  if (!access) throw new Error("Missing access token")

  const headers = new Headers({
    Authorization: `Bearer ${access}`,
    Accept: "application/json",
    "User-Agent": "opencode-sipmon/0.1",
  })
  const accountID = extractAccountId(auth)
  if (accountID) headers.set("ChatGPT-Account-Id", accountID)

  const response = await fetch(OPENAI_USAGE_ENDPOINT, { method: "GET", headers })
  if (!response.ok) {
    const shortBody = (await response.text()).slice(0, 220).replace(/\s+/g, " ")
    throw new Error(`Usage HTTP ${response.status}: ${shortBody}`)
  }

  const payload = asObject(await response.json())
  if (!payload) throw new Error("Usage payload is not an object")

  const windows = usageWindowsFromPayload(payload)
  const score = usageScore(windows)
  return { accountID, windows, score, usable: Number.isFinite(score) }
}

async function listSnapshotCandidates(sipmonProfilesDir, currentAuth, triedProfiles) {
  let names = []
  try {
    const entries = await fs.readdir(sipmonProfilesDir, { withFileTypes: true })
    names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name)
  } catch {
    return []
  }

  const candidates = []

  for (const fileName of names.sort((a, b) => a.localeCompare(b))) {
    const profileName = fileName.slice(0, -5)
    if (triedProfiles.has(profileName)) continue
    const filePath = path.join(sipmonProfilesDir, fileName)

    try {
      const auth = asObject(await readJsonObject(filePath))
      if (!auth) continue
      if (currentAuth && sameIdentity(auth, currentAuth)) continue

      let nextAuth = auth
      if (await shouldRefresh(nextAuth)) {
        nextAuth = await refreshAuth(nextAuth)
        await writeJsonAtomic(filePath, nextAuth)
      }

      const usage = await fetchUsageForAuth(nextAuth)
      candidates.push({
        profileName,
        filePath,
        auth: nextAuth,
        usable: usage.usable,
        score: usage.score,
        accountID: usage.accountID,
        windows: usage.windows,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      candidates.push({ profileName, filePath, usable: false, score: Number.NEGATIVE_INFINITY, reason: message })
    }
  }

  return candidates
}

async function writeActiveAuth(auth, paths) {
  let opencodeRoot = {}
  try {
    opencodeRoot = await readJsonObject(paths.opencodeAuthFile)
  } catch {
    opencodeRoot = {}
  }
  opencodeRoot.openai = auth
  await writeJsonAtomic(paths.opencodeAuthFile, opencodeRoot)

  let sipmonRoot = {}
  try {
    sipmonRoot = await readJsonObject(paths.sipmonAuthFile)
  } catch {
    sipmonRoot = {}
  }
  sipmonRoot.openai = auth
  await writeJsonAtomic(paths.sipmonAuthFile, sipmonRoot)
}

export async function OpenCodeSipmonFailoverPlugin(input) {
  const paths = resolveDataPaths()
  logEvent("plugin_initialized", {
    directory: input.directory,
    worktree: input.worktree,
    sipmonProfilesDir: paths.sipmonProfilesDir,
    opencodeAuthFile: paths.opencodeAuthFile,
  })

  async function triggerSwitchAndRetry({ sessionID, reason, source }) {
    const state = getAttemptState(sessionID)
    if (state.inFlight) return

    if (Date.now() - state.lastAttemptAt < DEFAULT_COOLDOWN_MS) {
      logEvent("retry_skipped_cooldown", { sessionID, source, cooldownMs: DEFAULT_COOLDOWN_MS })
      return
    }
    if (state.attempts >= DEFAULT_MAX_ATTEMPTS) {
      notify("OpenCode failover", `Automatic account switch attempts exhausted for session ${sessionID}.`)
      return
    }

    state.inFlight = true
    state.lastAttemptAt = Date.now()
    state.attempts += 1

    try {
      const currentAuth = await readCurrentOpenAIAuth(paths.opencodeAuthFile)
      const candidates = await listSnapshotCandidates(paths.sipmonProfilesDir, currentAuth, state.triedProfiles)

      logEvent("snapshot_candidates_evaluated", {
        sessionID,
        source,
        candidates: candidates.map((item) => ({
          profileName: item.profileName,
          usable: item.usable,
          score: Number.isFinite(item.score) ? item.score : null,
          accountID: item.accountID ?? null,
          fiveHour: item.windows?.fiveHour ?? null,
          sevenDay: item.windows?.sevenDay ?? null,
          reason: item.reason ?? null,
        })),
      })

      const usable = candidates.filter((item) => item.usable)
      usable.sort((a, b) => b.score - a.score)
      const best = usable[0]

      if (!best || !best.auth) {
        notify("OpenCode failover", "No usable sipmon snapshot found (requires both 5h and 7d remaining > 0).")
        return
      }

      state.triedProfiles.add(best.profileName)
      await writeActiveAuth(best.auth, paths)
      logEvent("active_auth_switched", {
        sessionID,
        source,
        profileName: best.profileName,
        accountID: best.accountID,
        fiveHour: best.windows?.fiveHour ?? null,
        sevenDay: best.windows?.sevenDay ?? null,
      })

      notify(
        "OpenCode failover",
        `Switched to ${best.profileName} (${Math.round(best.windows?.fiveHour ?? 0)}% 5h, ${Math.round(best.windows?.sevenDay ?? 0)}% 7d).`,
      )
      logEvent("switch_applied", { sessionID, source, profileName: best.profileName, attempt: state.attempts, reason })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notify("OpenCode failover", `Automatic account switch failed: ${message}`)
      logEvent("retry_failed", { sessionID, source, error: message })
    } finally {
      state.inFlight = false
    }
  }

  return {
    event: async ({ event }) => {
      const enabled = parseBoolean(process.env.OPENCODE_FAILOVER_ENABLED, true)
      if (!enabled) return

      if (event.type === "session.status") {
        const sessionID = event.properties?.sessionID
        const status = event.properties?.status
        if (!sessionID || !status || status.type !== "retry") return
        const reason = typeof status.message === "string" ? status.message : ""
        logEvent("session_retry_status_received", { sessionID, reason })
        if (!isUsageLimitMessage(reason)) return
        await triggerSwitchAndRetry({
          sessionID,
          source: "session.status.retry",
          reason: reason.slice(0, 260),
        })
        return
      }

      if (event.type !== "session.error") return

      const sessionID = event.properties?.sessionID
      const error = event.properties?.error
      const reason = extractErrorDetails(error).replace(/\s+/g, " ").slice(0, 260)
      logEvent("session_error_received", { sessionID, reason })
      if (!isUsageLimitMessage(reason)) return
      if (!sessionID) return

      await triggerSwitchAndRetry({
        sessionID,
        source: "session.error",
        reason,
      })
    },
  }
}

export default OpenCodeSipmonFailoverPlugin
