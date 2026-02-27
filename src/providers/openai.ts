import fs from "node:fs/promises"
import path from "node:path"
import type { ProfileUsage, ProviderAdapter, ProviderProfile, UsageWindow } from "./types"

const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OPENAI_ISSUER = "https://auth.openai.com"
const OPENAI_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"

type JsonObject = Record<string, unknown>

type OpenAIAuth = {
  type?: string
  access?: string
  refresh?: string
  expires?: number
  accountId?: string
} & JsonObject

type OpenAIPaths = {
  authFile: string
  openaiProfilesDir: string
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return value as JsonObject
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function parseJsonObject(content: string, filePath: string): JsonObject {
  const parsed = JSON.parse(content)
  const object = asObject(parsed)
  if (!object) {
    throw new Error(`Invalid JSON object in ${filePath}`)
  }
  return object
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
  const content = await fs.readFile(filePath, "utf8")
  return parseJsonObject(content, filePath)
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await fs.chmod(tmp, 0o600)
  await fs.rename(tmp, filePath)
}

function resolvePaths(): OpenAIPaths {
  const home = process.env.HOME || ""
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share")
  const dataDir = path.join(xdgDataHome, "opencode")
  const authFile = process.env.OPENCODE_AUTH_FILE || path.join(dataDir, "auth.json")
  const profilesRoot = process.env.OPENCODE_USAGE_PROFILES_DIR || path.join(dataDir, "profiles")
  const openaiProfilesDir = process.env.OPENCODE_OPENAI_PROFILES_DIR || path.join(profilesRoot, "openai")
  return { authFile, openaiProfilesDir }
}

function toOpenAIAuth(value: unknown): OpenAIAuth | null {
  const object = asObject(value)
  return object as OpenAIAuth | null
}

function decodeJwtPayload(token: string): JsonObject | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8")
    return asObject(JSON.parse(payload))
  } catch {
    return null
  }
}

function accountIdFromPayload(payload: JsonObject): string | null {
  const nested = asObject(payload["https://api.openai.com/auth"])
  const nestedAccountId = nested ? asString(nested.chatgpt_account_id) : null
  if (nestedAccountId) return nestedAccountId
  const rootAccountId = asString(payload.chatgpt_account_id)
  return rootAccountId || null
}

function extractAccountId(auth: OpenAIAuth): string | null {
  const explicit = asString(auth.accountId)
  if (explicit) return explicit
  const access = asString(auth.access)
  if (!access) return null
  const payload = decodeJwtPayload(access)
  if (!payload) return null
  return accountIdFromPayload(payload)
}

function sameIdentity(left: OpenAIAuth, right: OpenAIAuth): boolean {
  const leftRefresh = asString(left.refresh)
  const rightRefresh = asString(right.refresh)
  if (leftRefresh && rightRefresh && leftRefresh === rightRefresh) return true

  const leftAccountId = extractAccountId(left)
  const rightAccountId = extractAccountId(right)
  if (leftAccountId && rightAccountId && leftAccountId === rightAccountId) return true

  const leftAccess = asString(left.access)
  const rightAccess = asString(right.access)
  if (leftAccess && rightAccess && leftAccess === rightAccess) return true

  return false
}

async function readCurrentAuth(authFile: string): Promise<OpenAIAuth | null> {
  try {
    const root = await readJsonObject(authFile)
    return toOpenAIAuth(root.openai)
  } catch {
    return null
  }
}

async function writeCurrentAuth(authFile: string, auth: OpenAIAuth): Promise<void> {
  let root: JsonObject = {}
  try {
    root = await readJsonObject(authFile)
  } catch {
    root = {}
  }
  root.openai = auth
  await writeJsonAtomic(authFile, root)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

async function readSnapshots(dir: string): Promise<Array<{ name: string; filePath: string; auth: OpenAIAuth }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))

    const output: Array<{ name: string; filePath: string; auth: OpenAIAuth }> = []
    for (const file of files) {
      const filePath = path.join(dir, file)
      const parsed = await readJsonObject(filePath)
      const auth = toOpenAIAuth(parsed)
      if (!auth) continue
      output.push({ name: file.slice(0, -5), filePath, auth })
    }
    return output
  } catch {
    return []
  }
}

function usageWindowFromUnknown(value: unknown): UsageWindow | null {
  const object = asObject(value)
  if (!object) return null
  return {
    usedPercent: asNumber(object.used_percent),
    resetAfterSeconds: asNumber(object.reset_after_seconds),
    limitWindowSeconds: asNumber(object.limit_window_seconds),
  }
}

function parseUsagePayload(payload: JsonObject): ProfileUsage {
  const rateLimit = asObject(payload.rate_limit)
  const primary = usageWindowFromUnknown(rateLimit?.primary_window)
  const secondary = usageWindowFromUnknown(rateLimit?.secondary_window)

  let codexPrimary: UsageWindow | null = null
  let codexSecondary: UsageWindow | null = null

  const additional = payload.additional_rate_limits
  if (Array.isArray(additional)) {
    for (const item of additional) {
      const entry = asObject(item)
      if (!entry) continue
      const limitName = asString(entry.limit_name) || ""
      const meteredFeature = asString(entry.metered_feature) || ""
      if (!/codex/i.test(limitName) && !/codex/i.test(meteredFeature)) {
        continue
      }
      const extraRateLimit = asObject(entry.rate_limit)
      codexPrimary = usageWindowFromUnknown(extraRateLimit?.primary_window)
      codexSecondary = usageWindowFromUnknown(extraRateLimit?.secondary_window)
      break
    }
  }

  return {
    email: asString(payload.email),
    planType: asString(payload.plan_type),
    primary,
    secondary,
    codexPrimary,
    codexSecondary,
    error: null,
  }
}

function shouldRefresh(auth: OpenAIAuth): boolean {
  const access = asString(auth.access)
  const expires = asNumber(auth.expires)
  if (!access) return true
  if (expires === null) return false
  return expires <= Date.now() + 30_000
}

async function refreshToken(auth: OpenAIAuth): Promise<OpenAIAuth> {
  const refresh = asString(auth.refresh)
  if (!refresh) {
    throw new Error("Missing refresh token")
  }

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

  if (!response.ok) {
    throw new Error(`OAuth refresh failed (${response.status})`)
  }

  const payload = asObject(await response.json())
  if (!payload) {
    throw new Error("OAuth refresh returned invalid payload")
  }

  const accessToken = asString(payload.access_token)
  if (!accessToken) {
    throw new Error("OAuth refresh missing access_token")
  }

  const refreshTokenValue = asString(payload.refresh_token) || refresh
  const expiresIn = asNumber(payload.expires_in) || 3600

  const next: OpenAIAuth = {
    ...auth,
    type: "oauth",
    access: accessToken,
    refresh: refreshTokenValue,
    expires: Date.now() + expiresIn * 1000,
  }

  const accountId = extractAccountId(next)
  if (accountId) {
    next.accountId = accountId
  }

  return next
}

async function maybeRefreshProfileAuth(profile: ProviderProfile, paths: OpenAIPaths): Promise<OpenAIAuth> {
  const auth = toOpenAIAuth(profile.auth)
  if (!auth) {
    throw new Error("Invalid profile auth object")
  }

  if (!shouldRefresh(auth)) {
    return auth
  }

  const refreshed = await refreshToken(auth)

  if (profile.source === "snapshot") {
    await writeJsonAtomic(profile.path, refreshed)
  }
  if (profile.source === "current" || profile.isActive) {
    await writeCurrentAuth(paths.authFile, refreshed)
  }

  return refreshed
}

async function listProfiles(): Promise<ProviderProfile[]> {
  const paths = resolvePaths()
  const currentAuth = await readCurrentAuth(paths.authFile)
  const snapshots = await readSnapshots(paths.openaiProfilesDir)

  const rows: ProviderProfile[] = snapshots.map((snapshot) => ({
    providerId: "openai",
    name: snapshot.name,
    source: "snapshot",
    path: snapshot.filePath,
    auth: snapshot.auth,
    authType: asString(snapshot.auth.type) || "unknown",
    accountId: extractAccountId(snapshot.auth),
    isActive: currentAuth ? sameIdentity(snapshot.auth, currentAuth) : false,
  }))

  if (currentAuth) {
    rows.unshift({
      providerId: "openai",
      name: "@active",
      source: "current",
      path: paths.authFile,
      auth: currentAuth,
      authType: asString(currentAuth.type) || "unknown",
      accountId: extractAccountId(currentAuth),
      isActive: true,
    })
  }

  return rows
}

async function switchToProfile(profile: ProviderProfile): Promise<void> {
  const paths = resolvePaths()
  const auth = toOpenAIAuth(profile.auth)
  if (!auth) {
    throw new Error("Cannot switch profile with invalid auth payload")
  }
  await writeCurrentAuth(paths.authFile, auth)
}

function validateProfileName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error("Profile name is required")
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error("Invalid profile name (allowed: letters, numbers, ., _, -)")
  }
  return trimmed
}

async function saveCurrentProfile(name: string): Promise<{ path: string; overwritten: boolean }> {
  const profileName = validateProfileName(name)
  const paths = resolvePaths()
  const current = await readCurrentAuth(paths.authFile)
  if (!current) {
    throw new Error("No current openai auth found in auth.json")
  }

  await fs.mkdir(paths.openaiProfilesDir, { recursive: true })
  const filePath = path.join(paths.openaiProfilesDir, `${profileName}.json`)
  const overwritten = await pathExists(filePath)
  await writeJsonAtomic(filePath, current)
  return { path: filePath, overwritten }
}

async function fetchUsage(profile: ProviderProfile): Promise<ProfileUsage> {
  const paths = resolvePaths()

  let auth: OpenAIAuth
  try {
    auth = await maybeRefreshProfileAuth(profile, paths)
  } catch (error) {
    return {
      email: null,
      planType: null,
      primary: null,
      secondary: null,
      codexPrimary: null,
      codexSecondary: null,
      error: error instanceof Error ? error.message : "Token refresh failed",
    }
  }

  const access = asString(auth.access)
  if (!access) {
    return {
      email: null,
      planType: null,
      primary: null,
      secondary: null,
      codexPrimary: null,
      codexSecondary: null,
      error: "Missing access token",
    }
  }

  const headers = new Headers({
    Authorization: `Bearer ${access}`,
    Accept: "application/json",
    "User-Agent": "opencode-usage-tui/0.1",
  })
  const accountId = extractAccountId(auth)
  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId)
  }

  const response = await fetch(OPENAI_USAGE_ENDPOINT, {
    method: "GET",
    headers,
  })

  if (!response.ok) {
    const shortBody = (await response.text()).slice(0, 180).replace(/\s+/g, " ")
    return {
      email: null,
      planType: null,
      primary: null,
      secondary: null,
      codexPrimary: null,
      codexSecondary: null,
      error: `HTTP ${response.status}: ${shortBody}`,
    }
  }

  const payload = asObject(await response.json())
  if (!payload) {
    return {
      email: null,
      planType: null,
      primary: null,
      secondary: null,
      codexPrimary: null,
      codexSecondary: null,
      error: "Usage payload is not JSON object",
    }
  }

  return parseUsagePayload(payload)
}

export const openAIProvider: ProviderAdapter = {
  id: "openai",
  label: "OpenAI / Codex",
  listProfiles,
  switchToProfile,
  saveCurrentProfile,
  fetchUsage,
}
