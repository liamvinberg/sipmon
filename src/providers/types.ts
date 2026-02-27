export type UsageWindow = {
  usedPercent: number | null
  resetAfterSeconds: number | null
  limitWindowSeconds: number | null
}

export type ProfileUsage = {
  email: string | null
  planType: string | null
  primary: UsageWindow | null
  secondary: UsageWindow | null
  codeReviewAllowed: boolean | null
  codeReviewPrimary: UsageWindow | null
  codeReviewSecondary: UsageWindow | null
  codexAllowed: boolean | null
  codexPrimary: UsageWindow | null
  codexSecondary: UsageWindow | null
  codexLabel: string | null
  creditsBalance: string | null
  creditsUnlimited: boolean | null
  error: string | null
}

export type ProviderProfile = {
  providerId: string
  name: string
  source: "current" | "snapshot"
  path: string
  auth: Record<string, unknown>
  authType: string
  accountId: string | null
  isActive: boolean
}

export type ProviderAdapter = {
  id: string
  label: string
  loginWithOAuth: () => Promise<{ accountId: string | null }>
  listProfiles: () => Promise<ProviderProfile[]>
  switchToProfile: (profile: ProviderProfile) => Promise<void>
  saveCurrentProfile: (name: string) => Promise<{ path: string; overwritten: boolean }>
  renameProfile: (profile: ProviderProfile, name: string) => Promise<{ path: string }>
  deleteProfile: (profile: ProviderProfile) => Promise<void>
  fetchUsage: (profile: ProviderProfile) => Promise<ProfileUsage>
}
