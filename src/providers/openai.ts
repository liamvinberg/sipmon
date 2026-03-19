import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  ProviderLoginMethod,
  ProviderLoginMethodId,
  ProviderLoginResult,
  ProviderLoginSession,
  ProfileUsage,
  ProviderAdapter,
  ProviderProfile,
  UsageWindow,
} from "./types";

const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_SUBSCRIPTIONS_ENDPOINT = "https://chatgpt.com/backend-api/subscriptions";
const OPENAI_DEVICE_AUTHORIZE_ENDPOINT =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
const OPENAI_DEVICE_TOKEN_ENDPOINT =
  "https://auth.openai.com/api/accounts/deviceauth/token";
const OPENAI_DEVICE_LOGIN_URL = "https://auth.openai.com/codex/device";
const SUBSCRIPTION_CACHE_TTL_MIN_MS = 6 * 60 * 60 * 1000;
const SUBSCRIPTION_CACHE_TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const SUBSCRIPTION_NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;
const OAUTH_CALLBACK_PORT = 1455;
const OAUTH_CALLBACK_PATH = "/auth/callback";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;

type JsonObject = Record<string, unknown>;

type OpenAIAuth = {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
} & JsonObject;

type OpenAIPaths = {
  authFile: string;
  openaiProfilesDir: string;
  opencodeAuthFile: string;
  replicationTargets: string[];
};

type PkceCodes = {
  verifier: string;
  challenge: string;
};

type TokenResponse = {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type DeviceAuthResponse = {
  device_auth_id?: string;
  user_code?: string;
  interval?: string | number;
};

type DeviceTokenResponse = {
  authorization_code?: string;
  code_verifier?: string;
};

type DeviceAuthSession = {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
};

type SubscriptionCacheEntry = {
  activeUntil: string | null;
  expiresAt: number;
};

const loginMethods: ProviderLoginMethod[] = [
  {
    id: "browser",
    label: "Login in browser",
    description: "Open ChatGPT in your browser and complete OAuth there.",
  },
  {
    id: "code",
    label: "Use verification code",
    description: "Get a short code, enter it on OpenAI's device page, and wait here.",
  },
];

const subscriptionActiveUntilCache = new Map<string, SubscriptionCacheEntry>();

function subscriptionCacheTtlMs(activeUntil: string | null, now: number): number {
  if (!activeUntil) return SUBSCRIPTION_NEGATIVE_CACHE_TTL_MS;

  const endMs = new Date(activeUntil).getTime();
  if (!Number.isFinite(endMs)) return SUBSCRIPTION_NEGATIVE_CACHE_TTL_MS;

  const remainingMs = endMs - now;
  if (remainingMs <= 0) {
    return SUBSCRIPTION_NEGATIVE_CACHE_TTL_MS;
  }

  return Math.max(
    SUBSCRIPTION_CACHE_TTL_MIN_MS,
    Math.min(SUBSCRIPTION_CACHE_TTL_MAX_MS, remainingMs),
  );
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>sipmon</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background-color: #1a1b26; color: #c0caf5;">
    <div style="max-width: 480px; width: 100%; padding: 24px;">
      <div style="border: 1px solid #414868; background-color: #24283b; border-radius: 4px; padding: 24px; margin-bottom: 16px;">
        <div style="color: #565f89; font-size: 13px; margin-bottom: 16px;">sipmon</div>
        <div style="font-size: 18px; font-weight: 600; color: #9ece6a; margin-bottom: 8px;">Authorization successful</div>
        <div style="color: #a9b1d6; font-size: 14px;">You can close this window and return to sipmon.</div>
      </div>
      <div style="color: #565f89; font-size: 12px;">This window will close automatically.</div>
    </div>
    <script>setTimeout(() => window.close(), 1500)</script>
  </body>
</html>`;

function htmlError(message: string): string {
  return `<!doctype html>
<html>
  <head>
    <title>sipmon</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background-color: #1a1b26; color: #c0caf5;">
    <div style="max-width: 480px; width: 100%; padding: 24px;">
      <div style="border: 1px solid #414868; background-color: #24283b; border-radius: 4px; padding: 24px; margin-bottom: 16px;">
        <div style="color: #565f89; font-size: 13px; margin-bottom: 16px;">sipmon</div>
        <div style="font-size: 18px; font-weight: 600; color: #f7768e; margin-bottom: 8px;">Authorization failed</div>
        <pre style="white-space: pre-wrap; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; color: #a9b1d6; background-color: #1f2335; border: 1px solid #2f3449; border-radius: 4px; padding: 12px; margin: 0; overflow-x: auto;">${message}</pre>
      </div>
      <div style="color: #565f89; font-size: 12px;">Close this window and try again from sipmon.</div>
    </div>
  </body>
</html>`;
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseJsonObject(content: string, filePath: string): JsonObject {
  const parsed = JSON.parse(content);
  const object = asObject(parsed);
  if (!object) {
    throw new Error(`Invalid JSON object in ${filePath}`);
  }
  return object;
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
  const content = await fs.readFile(filePath, "utf8");
  return parseJsonObject(content, filePath);
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filePath);
}

function resolvePaths(): OpenAIPaths {
  const home = process.env.HOME || "";
  const xdgDataHome =
    process.env.XDG_DATA_HOME || path.join(home, ".local", "share");

  const sipmonDataDir =
    process.env.SIPMON_DATA_DIR || path.join(xdgDataHome, "sipmon");
  const authFile =
    process.env.SIPMON_AUTH_FILE || path.join(sipmonDataDir, "auth.json");
  const profilesRoot =
    process.env.SIPMON_PROFILES_DIR || path.join(sipmonDataDir, "profiles");
  const openaiProfilesDir =
    process.env.SIPMON_OPENAI_PROFILES_DIR || path.join(profilesRoot, "openai");

  const opencodeDataDir = path.join(xdgDataHome, "opencode");
  const opencodeAuthFile =
    process.env.OPENCODE_AUTH_FILE || path.join(opencodeDataDir, "auth.json");

  const replicationRaw = process.env.SIPMON_REPLICATION_TARGETS ?? "opencode";
  const replicationTargets = replicationRaw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  return { authFile, openaiProfilesDir, opencodeAuthFile, replicationTargets };
}

function toOpenAIAuth(value: unknown): OpenAIAuth | null {
  const object = asObject(value);
  return object as OpenAIAuth | null;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateRandomState(): string {
  return base64UrlEncode(randomBytes(32));
}

function generatePkce(): PkceCodes {
  const verifier = base64UrlEncode(randomBytes(64));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthorizeUrl(
  redirectUri: string,
  pkce: PkceCodes,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "sipmon",
  });
  return `${OPENAI_ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const response = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }
  return (await response.json()) as TokenResponse;
}

function parseDevicePollInterval(interval: string | number | undefined): number {
  const numericInterval =
    typeof interval === "number" ? interval : Number.parseFloat(interval || "");
  if (!Number.isFinite(numericInterval) || numericInterval <= 0) {
    return 5000;
  }
  return Math.round(numericInterval * 1000);
}

async function requestDeviceAuthSession(): Promise<DeviceAuthSession> {
  const response = await fetch(OPENAI_DEVICE_AUTHORIZE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "sipmon/0.1",
    },
    body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
  });
  if (!response.ok) {
    throw new Error(`Device authorization failed: ${response.status}`);
  }

  const payload = (await response.json()) as DeviceAuthResponse;
  const deviceAuthId = asString(payload.device_auth_id);
  const userCode = asString(payload.user_code);
  if (!deviceAuthId || !userCode) {
    throw new Error("Device authorization returned invalid payload");
  }

  return {
    deviceAuthId,
    userCode,
    intervalMs: parseDevicePollInterval(payload.interval),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authFromTokens(tokens: TokenResponse): OpenAIAuth {
  const access = asString(tokens.access_token);
  const refresh = asString(tokens.refresh_token);
  if (!access || !refresh) {
    throw new Error("OAuth response missing access or refresh token");
  }

  const expiresIn = asNumber(tokens.expires_in) || 3600;
  const accountId = extractAccountIdFromTokens(tokens);

  return {
    type: "oauth",
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
    ...(accountId ? { accountId } : {}),
  };
}

async function pollDeviceAuthTokens(
  session: DeviceAuthSession,
): Promise<TokenResponse> {
  for (;;) {
    const response = await fetch(OPENAI_DEVICE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "sipmon/0.1",
      },
      body: JSON.stringify({
        device_auth_id: session.deviceAuthId,
        user_code: session.userCode,
      }),
    });

    if (response.status === 403 || response.status === 404) {
      await sleep(session.intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Device token polling failed: ${response.status}`);
    }

    const payload = (await response.json()) as DeviceTokenResponse;
    const authorizationCode = asString(payload.authorization_code);
    const codeVerifier = asString(payload.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      throw new Error("Device token polling returned invalid payload");
    }

    return exchangeCodeForTokens(
      authorizationCode,
      `${OPENAI_ISSUER}/deviceauth/callback`,
      codeVerifier,
    );
  }
}

function decodeJwtPayload(token: string): JsonObject | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return asObject(JSON.parse(payload));
  } catch {
    return null;
  }
}

function accountIdFromPayload(payload: JsonObject): string | null {
  const nested = asObject(payload["https://api.openai.com/auth"]);
  const nestedAccountId = nested ? asString(nested.chatgpt_account_id) : null;
  if (nestedAccountId) return nestedAccountId;
  const rootAccountId = asString(payload.chatgpt_account_id);
  if (rootAccountId) return rootAccountId;
  const organizations = payload.organizations;
  if (Array.isArray(organizations) && organizations.length > 0) {
    const first = asObject(organizations[0]);
    const orgId = first ? asString(first.id) : null;
    if (orgId) return orgId;
  }
  return null;
}

function extractAccountId(auth: OpenAIAuth): string | null {
  const explicit = asString(auth.accountId);
  if (explicit) return explicit;
  const access = asString(auth.access);
  if (access) {
    const payload = decodeJwtPayload(access);
    if (payload) {
      const fromAccess = accountIdFromPayload(payload);
      if (fromAccess) return fromAccess;
    }
  }
  return null;
}

function extractAccountIdFromTokens(tokens: TokenResponse): string | null {
  const idToken = asString(tokens.id_token);
  if (idToken) {
    const payload = decodeJwtPayload(idToken);
    if (payload) {
      const fromId = accountIdFromPayload(payload);
      if (fromId) return fromId;
    }
  }
  const accessToken = asString(tokens.access_token);
  if (!accessToken) return null;
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;
  return accountIdFromPayload(payload);
}

function sameIdentity(left: OpenAIAuth, right: OpenAIAuth): boolean {
  const leftRefresh = asString(left.refresh);
  const rightRefresh = asString(right.refresh);
  if (leftRefresh && rightRefresh && leftRefresh === rightRefresh) return true;

  const leftAccountId = extractAccountId(left);
  const rightAccountId = extractAccountId(right);
  if (leftAccountId && rightAccountId && leftAccountId === rightAccountId)
    return true;

  const leftAccess = asString(left.access);
  const rightAccess = asString(right.access);
  if (leftAccess && rightAccess && leftAccess === rightAccess) return true;

  return false;
}

async function readCurrentAuth(authFile: string): Promise<OpenAIAuth | null> {
  try {
    const root = await readJsonObject(authFile);
    return toOpenAIAuth(root.openai);
  } catch {
    return null;
  }
}

function hasUsableAuth(auth: OpenAIAuth | null): auth is OpenAIAuth {
  if (!auth) return false;
  return Boolean(asString(auth.access) || asString(auth.refresh));
}

async function canImportMissingCurrentAuth(authFile: string): Promise<boolean> {
  try {
    const root = await readJsonObject(authFile);
    return !hasUsableAuth(toOpenAIAuth(root.openai));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return true;
    }
    return false;
  }
}

async function importOpenCodeAuth(paths: OpenAIPaths): Promise<OpenAIAuth | null> {
  const imported = await readCurrentAuth(paths.opencodeAuthFile);
  if (!hasUsableAuth(imported)) return null;

  await writeCurrentAuth(paths.authFile, imported);
  return imported;
}

async function readCurrentAuthWithImport(paths: OpenAIPaths): Promise<OpenAIAuth | null> {
  const current = await readCurrentAuth(paths.authFile);
  if (hasUsableAuth(current)) return current;
  if (!(await canImportMissingCurrentAuth(paths.authFile))) {
    return current;
  }
  return importOpenCodeAuth(paths);
}

async function writeCurrentAuth(
  authFile: string,
  auth: OpenAIAuth,
): Promise<void> {
  let root: JsonObject = {};
  try {
    root = await readJsonObject(authFile);
  } catch {
    root = {};
  }
  root.openai = auth;
  await writeJsonAtomic(authFile, root);
}

async function replicateAuth(
  auth: OpenAIAuth,
  paths: OpenAIPaths,
): Promise<void> {
  if (!paths.replicationTargets.includes("opencode")) {
    return;
  }

  let root: JsonObject = {};
  try {
    root = await readJsonObject(paths.opencodeAuthFile);
  } catch {
    root = {};
  }

  root.openai = auth;
  await writeJsonAtomic(paths.opencodeAuthFile, root);
}

async function writeActiveAuth(
  auth: OpenAIAuth,
  paths: OpenAIPaths,
): Promise<void> {
  await writeCurrentAuth(paths.authFile, auth);
  await replicateAuth(auth, paths);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readSnapshots(
  dir: string,
): Promise<Array<{ name: string; filePath: string; auth: OpenAIAuth }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    const output: Array<{ name: string; filePath: string; auth: OpenAIAuth }> =
      [];
    for (const file of files) {
      const filePath = path.join(dir, file);
      const parsed = await readJsonObject(filePath);
      const auth = toOpenAIAuth(parsed);
      if (!auth) continue;
      output.push({ name: file.slice(0, -5), filePath, auth });
    }
    return output;
  } catch {
    return [];
  }
}

function usageWindowFromUnknown(value: unknown): UsageWindow | null {
  const object = asObject(value);
  if (!object) return null;
  return {
    usedPercent: asNumber(object.used_percent),
    resetAfterSeconds: asNumber(object.reset_after_seconds),
    limitWindowSeconds: asNumber(object.limit_window_seconds),
  };
}

function emptyUsage(error: string | null): ProfileUsage {
  return {
    email: null,
    planType: null,
    subscriptionActiveUntil: null,
    primary: null,
    secondary: null,
    codeReviewAllowed: null,
    codeReviewPrimary: null,
    codeReviewSecondary: null,
    codexAllowed: null,
    codexPrimary: null,
    codexSecondary: null,
    codexLabel: null,
    creditsBalance: null,
    creditsUnlimited: null,
    error,
  };
}

function parseUsagePayload(payload: JsonObject): ProfileUsage {
  const rateLimit = asObject(payload.rate_limit);
  const primary = usageWindowFromUnknown(rateLimit?.primary_window);
  const secondary = usageWindowFromUnknown(rateLimit?.secondary_window);

  const codeReview = asObject(payload.code_review_rate_limit);
  const codeReviewAllowed = asBoolean(codeReview?.allowed);
  const codeReviewPrimary = usageWindowFromUnknown(codeReview?.primary_window);
  const codeReviewSecondary = usageWindowFromUnknown(
    codeReview?.secondary_window,
  );

  let codexAllowed: boolean | null = null;
  let codexPrimary: UsageWindow | null = null;
  let codexSecondary: UsageWindow | null = null;
  let codexLabel: string | null = null;

  const additional = payload.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const item of additional) {
      const entry = asObject(item);
      if (!entry) continue;
      const limitName = asString(entry.limit_name) || "";
      const meteredFeature = asString(entry.metered_feature) || "";
      if (!/codex/i.test(limitName) && !/codex/i.test(meteredFeature)) {
        continue;
      }
      const extraRateLimit = asObject(entry.rate_limit);
      codexAllowed = asBoolean(extraRateLimit?.allowed);
      codexPrimary = usageWindowFromUnknown(extraRateLimit?.primary_window);
      codexSecondary = usageWindowFromUnknown(extraRateLimit?.secondary_window);
      codexLabel = limitName || meteredFeature || "Codex";
      break;
    }
  }

  const credits = asObject(payload.credits);
  const creditsBalance = asString(credits?.balance);
  const creditsUnlimited =
    typeof credits?.unlimited === "boolean" ? credits.unlimited : null;

  return {
    email: asString(payload.email),
    planType: asString(payload.plan_type),
    subscriptionActiveUntil: null,
    primary,
    secondary,
    codeReviewAllowed,
    codeReviewPrimary,
    codeReviewSecondary,
    codexAllowed,
    codexPrimary,
    codexSecondary,
    codexLabel,
    creditsBalance,
    creditsUnlimited,
    error: null,
  };
}

async function fetchSubscriptionActiveUntil(
  accessToken: string,
  accountId: string | null,
): Promise<string | null> {
  if (!accountId) return null;

  const now = Date.now();
  const cached = subscriptionActiveUntilCache.get(accountId);
  if (cached && cached.expiresAt > now) {
    return cached.activeUntil;
  }

  const params = new URLSearchParams({ account_id: accountId });
  const response = await fetch(
    `${OPENAI_SUBSCRIPTIONS_ENDPOINT}?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "sipmon/0.1",
      },
    },
  );

  if (!response.ok) {
    subscriptionActiveUntilCache.set(accountId, {
      activeUntil: null,
      expiresAt: now + SUBSCRIPTION_NEGATIVE_CACHE_TTL_MS,
    });
    return null;
  }

  const payload = asObject(await response.json());
  if (!payload) {
    subscriptionActiveUntilCache.set(accountId, {
      activeUntil: null,
      expiresAt: now + SUBSCRIPTION_NEGATIVE_CACHE_TTL_MS,
    });
    return null;
  }

  const activeUntil = asString(payload.active_until);
  subscriptionActiveUntilCache.set(accountId, {
    activeUntil,
    expiresAt: now + subscriptionCacheTtlMs(activeUntil, now),
  });

  return activeUntil;
}

function shouldRefresh(auth: OpenAIAuth): boolean {
  const access = asString(auth.access);
  const expires = asNumber(auth.expires);
  if (!access) return true;
  if (expires === null) return false;
  return expires <= Date.now() + 30_000;
}

async function refreshToken(auth: OpenAIAuth): Promise<OpenAIAuth> {
  const refresh = asString(auth.refresh);
  if (!refresh) {
    throw new Error("Missing refresh token");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: OPENAI_OAUTH_CLIENT_ID,
  });

  const response = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`OAuth refresh failed (${response.status})`);
  }

  const payload = asObject(await response.json());
  if (!payload) {
    throw new Error("OAuth refresh returned invalid payload");
  }

  const accessToken = asString(payload.access_token);
  if (!accessToken) {
    throw new Error("OAuth refresh missing access_token");
  }

  const refreshTokenValue = asString(payload.refresh_token) || refresh;
  const expiresIn = asNumber(payload.expires_in) || 3600;

  const next: OpenAIAuth = {
    ...auth,
    type: "oauth",
    access: accessToken,
    refresh: refreshTokenValue,
    expires: Date.now() + expiresIn * 1000,
  };

  const accountId = extractAccountId(next);
  if (accountId) {
    next.accountId = accountId;
  }

  return next;
}

async function maybeRefreshProfileAuth(
  profile: ProviderProfile,
  paths: OpenAIPaths,
): Promise<OpenAIAuth> {
  const auth = toOpenAIAuth(profile.auth);
  if (!auth) {
    throw new Error("Invalid profile auth object");
  }

  if (!shouldRefresh(auth)) {
    return auth;
  }

  const refreshed = await refreshToken(auth);

  if (profile.source === "snapshot") {
    await writeJsonAtomic(profile.path, refreshed);
  }
  if (profile.source === "current" || profile.isActive) {
    await writeActiveAuth(refreshed, paths);
  }

  return refreshed;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      stdio: "ignore",
      detached: true,
    }).unref();
    return;
  }
  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

function sendHtml(
  res: ServerResponse<IncomingMessage>,
  status: number,
  html: string,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function startBrowserLogin(): ProviderLoginSession {
  const redirectUri = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
  const pkce = generatePkce();
  const state = generateRandomState();
  const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);

  const tokensPromise = new Promise<TokenResponse>((resolve, reject) => {
    let server: ReturnType<typeof createServer> | null = null;
    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error("OAuth callback timeout"));
    }, OAUTH_TIMEOUT_MS);

    server = createServer(async (req, res) => {
      const requestUrl = new URL(req.url || "/", redirectUri);
      if (requestUrl.pathname !== OAUTH_CALLBACK_PATH) {
        sendHtml(res, 404, htmlError("Not found"));
        return;
      }

      const error = requestUrl.searchParams.get("error");
      const errorDescription = requestUrl.searchParams.get("error_description");
      if (error) {
        const message = errorDescription || error;
        sendHtml(res, 400, htmlError(message));
        clearTimeout(timeout);
        server?.close();
        reject(new Error(message));
        return;
      }

      const code = requestUrl.searchParams.get("code");
      const returnedState = requestUrl.searchParams.get("state");

      if (!code) {
        sendHtml(res, 400, htmlError("Missing authorization code"));
        clearTimeout(timeout);
        server?.close();
        reject(new Error("Missing authorization code"));
        return;
      }

      if (!returnedState || returnedState !== state) {
        sendHtml(res, 400, htmlError("Invalid state parameter"));
        clearTimeout(timeout);
        server?.close();
        reject(new Error("Invalid state parameter"));
        return;
      }

      try {
        const tokens = await exchangeCodeForTokens(code, redirectUri, pkce.verifier);
        sendHtml(res, 200, HTML_SUCCESS);
        clearTimeout(timeout);
        server?.close();
        resolve(tokens);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Token exchange failed";
        sendHtml(res, 500, htmlError(message));
        clearTimeout(timeout);
        server?.close();
        reject(new Error(message));
      }
    });

    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    server.listen(OAUTH_CALLBACK_PORT, "localhost", () => {
      openBrowser(authUrl);
    });
  });

  return {
    url: authUrl,
    code: null,
    complete: async () => finalizeLogin(authFromTokens(await tokensPromise)),
  };
}

async function finalizeLogin(auth: OpenAIAuth): Promise<ProviderLoginResult> {
  const paths = resolvePaths();
  await writeActiveAuth(auth, paths);
  const accountId = extractAccountId(auth);
  const snapshotName = accountId || "openai-profile";
  await saveCurrentProfile(snapshotName);
  return { accountId };
}

async function startDeviceCodeLogin(): Promise<ProviderLoginSession> {
  const session = await requestDeviceAuthSession();
  return {
    url: OPENAI_DEVICE_LOGIN_URL,
    code: session.userCode,
    complete: async () => finalizeLogin(authFromTokens(await pollDeviceAuthTokens(session))),
  };
}

async function startLogin(
  methodId: ProviderLoginMethodId,
): Promise<ProviderLoginSession> {
  if (methodId === "browser") {
    return startBrowserLogin();
  }
  if (methodId === "code") {
    return startDeviceCodeLogin();
  }
  throw new Error(`Unsupported login method: ${methodId}`);
}

async function listProfiles(): Promise<ProviderProfile[]> {
  const paths = resolvePaths();
  const currentAuth = await readCurrentAuthWithImport(paths);
  const snapshots = await readSnapshots(paths.openaiProfilesDir);

  const rows: ProviderProfile[] = snapshots.map((snapshot) => ({
    providerId: "openai",
    name: snapshot.name,
    source: "snapshot",
    path: snapshot.filePath,
    auth: snapshot.auth,
    authType: asString(snapshot.auth.type) || "unknown",
    accountId: extractAccountId(snapshot.auth),
    isActive: false,
  }));

  if (currentAuth) {
    const matchedIndex = rows.findIndex((row) => {
      const auth = toOpenAIAuth(row.auth);
      return auth ? sameIdentity(auth, currentAuth) : false;
    });

    if (matchedIndex >= 0) {
      rows[matchedIndex] = {
        ...rows[matchedIndex],
        isActive: true,
      };
    } else {
      rows.unshift({
        providerId: "openai",
        name: "@active",
        source: "current",
        path: paths.authFile,
        auth: currentAuth,
        authType: asString(currentAuth.type) || "unknown",
        accountId: extractAccountId(currentAuth),
        isActive: true,
      });
    }
  }

  return rows;
}

async function switchToProfile(profile: ProviderProfile): Promise<void> {
  const paths = resolvePaths();
  const auth = toOpenAIAuth(profile.auth);
  if (!auth) {
    throw new Error("Cannot switch profile with invalid auth payload");
  }
  await writeActiveAuth(auth, paths);
}

function validateProfileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Profile name is required");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      "Invalid profile name (allowed: letters, numbers, ., _, -)",
    );
  }
  return trimmed;
}

async function saveCurrentProfile(
  name: string,
): Promise<{ path: string; overwritten: boolean }> {
  const profileName = validateProfileName(name);
  const paths = resolvePaths();
  const current = await readCurrentAuth(paths.authFile);
  if (!current) {
    throw new Error("No current openai auth found in sipmon auth.json");
  }

  await fs.mkdir(paths.openaiProfilesDir, { recursive: true });
  const snapshots = await readSnapshots(paths.openaiProfilesDir);
  const currentAccountId = extractAccountId(current);

  const accountMatch = currentAccountId
    ? snapshots.find(
        (snapshot) => extractAccountId(snapshot.auth) === currentAccountId,
      )
    : null;
  const identityMatch = snapshots.find((snapshot) =>
    sameIdentity(snapshot.auth, current),
  );
  const existingMatch = accountMatch || identityMatch || null;

  const filePath = existingMatch
    ? existingMatch.filePath
    : path.join(paths.openaiProfilesDir, `${profileName}.json`);
  const overwritten = existingMatch ? true : await pathExists(filePath);
  await writeJsonAtomic(filePath, current);
  return { path: filePath, overwritten };
}

async function deleteProfile(profile: ProviderProfile): Promise<void> {
  if (profile.source !== "snapshot") {
    throw new Error("Only saved snapshots can be deleted");
  }
  await fs.rm(profile.path, { force: true });
}

async function fetchUsage(profile: ProviderProfile): Promise<ProfileUsage> {
  const paths = resolvePaths();

  let auth: OpenAIAuth;
  try {
    auth = await maybeRefreshProfileAuth(profile, paths);
  } catch (error) {
    return emptyUsage(
      error instanceof Error ? error.message : "Token refresh failed",
    );
  }

  const access = asString(auth.access);
  if (!access) {
    return emptyUsage("Missing access token");
  }

  const headers = new Headers({
    Authorization: `Bearer ${access}`,
    Accept: "application/json",
    "User-Agent": "sipmon/0.1",
  });
  const accountId = extractAccountId(auth);
  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId);
  }

  const response = await fetch(OPENAI_USAGE_ENDPOINT, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const shortBody = (await response.text())
      .slice(0, 180)
      .replace(/\s+/g, " ");
    return emptyUsage(`HTTP ${response.status}: ${shortBody}`);
  }

  const payload = asObject(await response.json());
  if (!payload) {
    return emptyUsage("Usage payload is not JSON object");
  }

  const parsed = parseUsagePayload(payload);
  try {
    parsed.subscriptionActiveUntil = await fetchSubscriptionActiveUntil(
      access,
      accountId,
    );
  } catch {
    parsed.subscriptionActiveUntil = null;
  }
  return parsed;
}

export const openAIProvider: ProviderAdapter = {
  id: "openai",
  label: "OpenAI / Codex",
  loginMethods,
  startLogin,
  listProfiles,
  switchToProfile,
  saveCurrentProfile,
  deleteProfile,
  fetchUsage,
};
