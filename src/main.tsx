import { createCliRenderer, TextAttributes } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { providers } from "./providers"
import type { ProfileUsage, ProviderProfile, UsageWindow } from "./providers/types"

const provider = providers[0]

const MAX_WIDTH = 120

const theme = {
  bgBase: "#1a1b26",
  bgPanel: "#1f2335",
  bgHeader: "#24283b",
  bgSelected: "#292e42",
  bgBarTrack: "#3b3f57",

  text: "#c0caf5",
  textDim: "#565f89",
  textMuted: "#a9b1d6",

  border: "#2f3449",
  borderFocus: "#414868",

  accent: "#7aa2f7",
  success: "#9ece6a",
  warning: "#e0af68",
  error: "#f7768e",
}

type KeyboardEventLike = {
  name?: string
  sequence?: string
  repeated?: boolean
  ctrl?: boolean
  meta?: boolean
}

type ProfileRow = {
  profile: ProviderProfile
  usage: ProfileUsage | null
  loading: boolean
}

type RenameMode = {
  profile: ProviderProfile
  value: string
}

type DeleteMode = {
  profile: ProviderProfile
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 1) return value.slice(0, width)
  return `${value.slice(0, width - 1)}\u2026`
}

function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

function remainingPercent(window: UsageWindow | null): number | null {
  const used = clampPercent(window?.usedPercent ?? null)
  if (used === null) return null
  return Math.max(0, Math.min(100, 100 - used))
}

function metricColor(window: UsageWindow | null): string {
  const remaining = remainingPercent(window)
  if (remaining === null) return theme.textDim
  if (remaining >= 60) return theme.success
  if (remaining >= 30) return theme.warning
  return theme.error
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "--"
  const total = Math.max(0, Math.round(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function remainingText(window: UsageWindow | null): string {
  const remaining = remainingPercent(window)
  if (remaining === null) return "--"
  return `${Math.round(remaining)}%`
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return "Unknown error"
}

function extractInputCharacter(key: KeyboardEventLike): string | null {
  if (key.ctrl || key.meta) return null
  const sequence = typeof key.sequence === "string" ? key.sequence : ""
  if (sequence.length === 1 && /^[A-Za-z0-9._-]$/.test(sequence)) {
    return sequence
  }
  const name = typeof key.name === "string" ? key.name : ""
  if (name.length === 1 && /^[A-Za-z0-9._-]$/.test(name)) {
    return name
  }
  return null
}

function summaryStatus(row: ProfileRow): string {
  if (row.loading) return "..."
  if (row.usage?.error) return "err"
  return "ok"
}

function profileDisplayName(row: ProfileRow): string {
  return row.usage?.email || row.profile.name
}

function UsageBar({ label, window }: { label: string; window: UsageWindow | null }) {
  const remaining = remainingPercent(window)
  const color = metricColor(window)
  const reset = formatDuration(window?.resetAfterSeconds ?? null)
  const pctText = remaining !== null ? `${Math.round(remaining)}%` : "--"

  return (
    <box style={{ flexDirection: "row", gap: 1, height: 1 }}>
      <box style={{ width: 18 }}>
        <text attributes={TextAttributes.DIM} fg={theme.textMuted}>
          {truncate(label, 17)}
        </text>
      </box>
      <box style={{ flexGrow: 1, backgroundColor: theme.bgBarTrack, height: 1 }}>
        {remaining !== null && remaining > 0 ? (
          <box style={{ width: `${Math.round(remaining)}%`, height: 1, backgroundColor: color }} />
        ) : null}
      </box>
      <box style={{ width: 5 }}>
        <text fg={color}>{pctText}</text>
      </box>
      <box style={{ width: 10 }}>
        <text attributes={TextAttributes.DIM} fg={theme.textDim}>
          {"rst " + reset}
        </text>
      </box>
    </box>
  )
}

function App() {
  const [rows, setRows] = useState<ProfileRow[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [statusLine, setStatusLine] = useState("Initializing...")
  const [lastRefresh, setLastRefresh] = useState("--")
  const [refreshing, setRefreshing] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [renameMode, setRenameMode] = useState<RenameMode | null>(null)
  const [deleteMode, setDeleteMode] = useState<DeleteMode | null>(null)
  const busyRef = useRef(false)

  const selectedRow = rows[selectedIndex] || null
  const activeRow = useMemo(() => rows.find((row) => row.profile.isActive) || null, [rows])
  const activeSaved = activeRow?.profile.source === "snapshot"
  const activeDisplayName = activeRow ? profileDisplayName(activeRow) : null
  const selectedDisplayName = selectedRow ? profileDisplayName(selectedRow) : null

  const refreshAll = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setRefreshing(true)
    setStatusLine("Refreshing...")

    try {
      const profiles = await provider.listProfiles()
      if (profiles.length === 0) {
        setRows([])
        setSelectedIndex(0)
        setLastRefresh("--")
        setStatusLine("No profiles found. Login with a.")
        return
      }

      setRows(
        profiles.map((profile) => ({
          profile,
          usage: null,
          loading: true,
        })),
      )

      const usageList = await Promise.all(profiles.map((profile) => provider.fetchUsage(profile)))
      const nextRows = profiles.map((profile, index) => ({
        profile,
        usage: usageList[index],
        loading: false,
      }))

      const errorCount = nextRows.filter((row) => row.usage?.error).length
      setRows(nextRows)
      setSelectedIndex((index) => Math.max(0, Math.min(index, nextRows.length - 1)))
      setLastRefresh(new Date().toLocaleTimeString())
      setStatusLine(
        errorCount === 0
          ? `Loaded ${nextRows.length} profile(s)`
          : `Loaded ${nextRows.length} profile(s), ${errorCount} error(s)`,
      )
    } catch (error) {
      setStatusLine(`Refresh failed: ${normalizeError(error)}`)
    } finally {
      busyRef.current = false
      setRefreshing(false)
    }
  }, [])

  const switchSelected = useCallback(async () => {
    if (refreshing || switching || loggingIn || renaming || deleting) return
    const row = selectedRow
    if (!row) return
    if (row.profile.isActive) {
      setStatusLine(`${row.profile.name} is already active`)
      return
    }

    setSwitching(true)
    setStatusLine(`Switching to ${row.profile.name}...`)
    try {
      await provider.switchToProfile(row.profile)
      await refreshAll()
      setStatusLine(`Switched to ${row.profile.name}`)
    } catch (error) {
      setStatusLine(`Switch failed: ${normalizeError(error)}`)
    } finally {
      setSwitching(false)
    }
  }, [deleting, loggingIn, refreshAll, refreshing, renaming, selectedRow, switching])

  const loginWithOAuth = useCallback(async () => {
    if (refreshing || switching || loggingIn || renaming || deleting) return
    setLoggingIn(true)
    setStatusLine("Starting OAuth login in browser...")
    try {
      const result = await provider.loginWithOAuth()
      await refreshAll()
      if (result.accountId) {
        setStatusLine(`OAuth login successful (${result.accountId})`)
      } else {
        setStatusLine("OAuth login successful")
      }
    } catch (error) {
      setStatusLine(`OAuth login failed: ${normalizeError(error)}`)
    } finally {
      setLoggingIn(false)
    }
  }, [deleting, loggingIn, refreshAll, refreshing, renaming, switching])

  const beginRename = useCallback(() => {
    if (!selectedRow) return
    if (selectedRow.profile.source !== "snapshot") {
      setStatusLine("Select a saved profile to rename")
      return
    }
    setDeleteMode(null)
    setRenameMode({
      profile: selectedRow.profile,
      value: selectedRow.profile.name,
    })
    setStatusLine("Rename mode: edit name and press Enter")
  }, [selectedRow])

  const submitRename = useCallback(async () => {
    if (!renameMode) return
    const targetName = renameMode.value.trim()
    if (!targetName) {
      setStatusLine("Rename requires a name")
      return
    }
    setRenaming(true)
    try {
      await provider.renameProfile(renameMode.profile, targetName)
      setRenameMode(null)
      await refreshAll()
      setStatusLine(`Renamed to ${targetName}`)
    } catch (error) {
      setStatusLine(`Rename failed: ${normalizeError(error)}`)
    } finally {
      setRenaming(false)
    }
  }, [refreshAll, renameMode])

  const beginDelete = useCallback(() => {
    if (!selectedRow) return
    if (selectedRow.profile.source !== "snapshot") {
      setStatusLine("Select a saved profile to delete")
      return
    }
    setRenameMode(null)
    setDeleteMode({ profile: selectedRow.profile })
    setStatusLine(`Delete ${selectedRow.profile.name}? y to confirm, n to cancel`)
  }, [selectedRow])

  const submitDelete = useCallback(async () => {
    if (!deleteMode) return
    setDeleting(true)
    try {
      await provider.deleteProfile(deleteMode.profile)
      const deletedName = deleteMode.profile.name
      setDeleteMode(null)
      await refreshAll()
      setStatusLine(`Deleted ${deletedName}`)
    } catch (error) {
      setStatusLine(`Delete failed: ${normalizeError(error)}`)
    } finally {
      setDeleting(false)
    }
  }, [deleteMode, refreshAll])

  useKeyboard((rawKey) => {
    const key = rawKey as KeyboardEventLike

    if (renameMode) {
      if (key.name === "escape") {
        setRenameMode(null)
        setStatusLine("Rename cancelled")
        return
      }
      if (key.name === "return") {
        void submitRename()
        return
      }
      if (key.name === "backspace" || key.name === "delete") {
        setRenameMode((mode) => (mode ? { ...mode, value: mode.value.slice(0, -1) } : mode))
        return
      }
      const char = extractInputCharacter(key)
      if (char) {
        setRenameMode((mode) => (mode ? { ...mode, value: mode.value + char } : mode))
      }
      return
    }

    if (deleteMode) {
      if (key.name === "y") {
        void submitDelete()
        return
      }
      if (key.name === "n" || key.name === "escape") {
        setDeleteMode(null)
        setStatusLine("Delete cancelled")
      }
      return
    }

    if (key.name === "q" || key.name === "escape") {
      process.exit(0)
    }
    if (key.name === "up" || key.name === "k") {
      setSelectedIndex((index) => Math.max(0, index - 1))
      return
    }
    if (key.name === "down" || key.name === "j") {
      setSelectedIndex((index) => Math.min(rows.length - 1, index + 1))
      return
    }
    if ((key.name === "s" || key.name === "return") && !key.repeated) {
      void switchSelected()
      return
    }
    if (key.name === "a" && !key.repeated) {
      void loginWithOAuth()
      return
    }
    if (key.name === "r" && !key.repeated) {
      beginRename()
      return
    }
    if (key.name === "d" && !key.repeated) {
      beginDelete()
      return
    }
    if (key.name === "u" && !key.repeated) {
      void refreshAll()
    }
  })

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  useEffect(() => {
    const interval = setInterval(() => {
      void refreshAll()
    }, 60_000)
    return () => clearInterval(interval)
  }, [refreshAll])

  const selectedUsage = selectedRow?.usage || null
  const selectedCodexLabel = selectedUsage?.codexLabel || "Codex"
  const hasCodexData = Boolean(
    selectedUsage &&
      (selectedUsage.codexLabel ||
        selectedUsage.codexAllowed !== null ||
        selectedUsage.codexPrimary ||
        selectedUsage.codexSecondary),
  )
  const hasCodeReviewData = Boolean(
    selectedUsage &&
      (selectedUsage.codeReviewAllowed !== null || selectedUsage.codeReviewPrimary || selectedUsage.codeReviewSecondary),
  )
  const selectedCodeReviewWindow = selectedUsage?.codeReviewPrimary || selectedUsage?.codeReviewSecondary || null

  const isBusy = refreshing || switching || loggingIn || renaming || deleting

  const contextLine = renameMode
    ? `Rename: ${renameMode.value || "<name>"} (Enter confirm, Esc cancel)`
    : deleteMode
      ? `Delete ${deleteMode.profile.name}? (y confirm, n cancel)`
      : "j/k move  a login(oauth)  s switch  r rename  d delete  u refresh  q quit"

  return (
    <box style={{ backgroundColor: theme.bgBase, alignItems: "center", justifyContent: "center", height: "100%" }}>
      <box style={{ maxWidth: MAX_WIDTH, width: "100%", padding: 1, flexDirection: "column" }}>
      {/* Header */}
      <box
        title=" sipmon "
        style={{
          border: true,
          borderColor: theme.borderFocus,
          backgroundColor: theme.bgHeader,
          padding: 1,
          flexDirection: "column",
          marginBottom: 1,
        }}
      >
        <text>
          <span fg={theme.textDim}>{"Provider "}</span>
          <span fg={theme.textMuted}>{provider.label}</span>
          <span fg={theme.textDim}>{"  Refreshed "}</span>
          <span fg={theme.textMuted}>{lastRefresh}</span>
        </text>
        <text>
          <span fg={theme.textDim}>{"Active "}</span>
          <span fg={activeSaved ? theme.accent : theme.warning}>
            {activeSaved ? activeDisplayName || "--" : "active only (login with a)"}
          </span>
        </text>
        <text attributes={TextAttributes.DIM} fg={theme.textDim}>
          {contextLine}
        </text>
        <text fg={isBusy ? theme.warning : theme.textMuted}>{statusLine}</text>
      </box>

      {/* Profile Table */}
      <box
        style={{
          border: true,
          borderColor: theme.border,
          padding: 1,
          flexDirection: "column",
          marginBottom: 1,
        }}
      >
        <box style={{ flexDirection: "row", marginBottom: 1 }}>
          <box style={{ width: 4 }}>
            <text>{" "}</text>
          </box>
          <box style={{ width: 34 }}>
            <text attributes={TextAttributes.DIM} fg={theme.textDim}>
              Profile
            </text>
          </box>
          <box style={{ width: 7 }}>
            <text attributes={TextAttributes.DIM} fg={theme.textDim}>
              Plan
            </text>
          </box>
          <box style={{ width: 7 }}>
            <text attributes={TextAttributes.DIM} fg={theme.textDim}>
              5h
            </text>
          </box>
          <box style={{ width: 7 }}>
            <text attributes={TextAttributes.DIM} fg={theme.textDim}>
              7d
            </text>
          </box>
          <box style={{ width: 7 }}>
            <text attributes={TextAttributes.DIM} fg={theme.textDim}>
              Codex
            </text>
          </box>
          <box style={{ width: 7 }}>
            <text attributes={TextAttributes.DIM} fg={theme.textDim}>
              Status
            </text>
          </box>
        </box>
        {rows.length === 0 ? (
          <text fg={theme.textDim}>No profiles detected.</text>
        ) : (
          rows.map((row, index) => {
            const selected = index === selectedIndex
            const indicator = `${selected ? ">" : " "}${row.profile.isActive ? "*" : " "}`
            const plan = row.usage?.planType || "--"
            const p5 = remainingText(row.usage?.primary || null)
            const p7 = remainingText(row.usage?.secondary || null)
            const codex = remainingText(row.usage?.codexPrimary || null)
            const status = summaryStatus(row)
            const displayName = profileDisplayName(row)
            const nameColor = row.usage?.error
              ? theme.error
              : selected
                ? theme.text
                : row.profile.isActive
                  ? theme.accent
                  : theme.textMuted

            return (
              <box
                key={`${row.profile.source}:${row.profile.name}:${index}`}
                style={{
                  flexDirection: "row",
                  backgroundColor: selected ? theme.bgSelected : undefined,
                }}
              >
                <box style={{ width: 4 }}>
                  <text fg={selected ? theme.accent : theme.textDim}>{indicator}</text>
                </box>
                <box style={{ width: 34 }}>
                  <text fg={nameColor}>{truncate(displayName, 33)}</text>
                </box>
                <box style={{ width: 7 }}>
                  <text fg={theme.textMuted}>{plan}</text>
                </box>
                <box style={{ width: 7 }}>
                  <text fg={metricColor(row.usage?.primary || null)}>{p5}</text>
                </box>
                <box style={{ width: 7 }}>
                  <text fg={metricColor(row.usage?.secondary || null)}>{p7}</text>
                </box>
                <box style={{ width: 7 }}>
                  <text fg={metricColor(row.usage?.codexPrimary || null)}>{codex}</text>
                </box>
                <box style={{ width: 7 }}>
                  <text
                    fg={
                      status === "err" ? theme.error : status === "..." ? theme.warning : theme.textDim
                    }
                  >
                    {status}
                  </text>
                </box>
              </box>
            )
          })
        )}
      </box>

      {/* Detail Panel */}
      <box
        title={selectedDisplayName ? ` ${selectedDisplayName} ` : undefined}
        style={{
          border: true,
          borderColor: selectedRow ? theme.borderFocus : theme.border,
          backgroundColor: theme.bgPanel,
          padding: 1,
          flexDirection: "column",
        }}
      >
        {!selectedRow ? (
          <text fg={theme.textDim}>No profile selected.</text>
        ) : (
          <>
            <text>
              <span fg={theme.textDim}>{selectedRow.profile.isActive ? "active" : "saved"}</span>
              <span fg={theme.textDim}>{" | "}</span>
              <span fg={theme.textDim}>{selectedRow.profile.authType}</span>
            </text>
            <text>
              <span fg={theme.textDim}>{"Plan "}</span>
              <span fg={theme.textMuted}>{selectedUsage?.planType || "--"}</span>
              <span fg={theme.textDim}>{"  Email "}</span>
              <span fg={theme.textMuted}>{selectedUsage?.email || "--"}</span>
              <span fg={theme.textDim}>{"  Account "}</span>
              <span fg={theme.textMuted}>{selectedRow.profile.accountId || "--"}</span>
            </text>

            <box style={{ marginTop: 1, flexDirection: "column", gap: 1 }}>
              <UsageBar label="Primary 5h" window={selectedUsage?.primary || null} />
              <UsageBar label="Weekly 7d" window={selectedUsage?.secondary || null} />
              {hasCodexData ? (
                selectedUsage?.codexAllowed === false ? (
                  <text fg={theme.textDim}>{selectedCodexLabel + ": unavailable"}</text>
                ) : (
                  <>
                    <UsageBar
                      label={`${selectedCodexLabel} 5h`}
                      window={selectedUsage?.codexPrimary || null}
                    />
                    <UsageBar
                      label={`${selectedCodexLabel} 7d`}
                      window={selectedUsage?.codexSecondary || null}
                    />
                  </>
                )
              ) : null}
              {hasCodeReviewData ? (
                selectedUsage?.codeReviewAllowed === false ? (
                  <text fg={theme.textDim}>Code review: unavailable</text>
                ) : (
                  <UsageBar label="Code review" window={selectedCodeReviewWindow} />
                )
              ) : null}
            </box>

            <text>
              <span fg={theme.textDim}>{"Credits "}</span>
              <span fg={theme.textMuted}>
                {selectedUsage?.creditsUnlimited ? "unlimited" : selectedUsage?.creditsBalance || "0"}
              </span>
            </text>
            {selectedUsage?.error ? (
              <text fg={theme.error}>{"Error: " + selectedUsage.error}</text>
            ) : null}
          </>
        )}
      </box>
      </box>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
