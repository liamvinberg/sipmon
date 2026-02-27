import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { providers } from "./providers"
import type { ProfileUsage, ProviderProfile, UsageWindow } from "./providers/types"

const provider = providers[0]
const BAR_WIDTH = 24

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

function padRight(value: string, width: number): string {
  if (value.length >= width) return value
  return value + " ".repeat(width - value.length)
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return padRight(value, width)
  if (width <= 1) return value.slice(0, width)
  return `${value.slice(0, width - 1)}…`
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
  if (remaining === null) return "#7aa2f7"
  if (remaining >= 60) return "#9ece6a"
  if (remaining >= 30) return "#e0af68"
  return "#f7768e"
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

function formatBar(window: UsageWindow | null): string {
  const remaining = remainingPercent(window)
  if (remaining === null) {
    return `[${"-".repeat(BAR_WIDTH)}] --% remaining`
  }
  const filled = Math.round((remaining / 100) * BAR_WIDTH)
  const bar = `${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}`
  return `[${bar}] ${String(Math.round(remaining)).padStart(3, " ")}% remaining`
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

function toSnapshotName(value: string): string {
  const lowered = value.trim().toLowerCase().replace(/@/g, "-at-")
  const sanitized = lowered.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
  return sanitized || "openai-profile"
}

function snapshotNameFromPath(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() || filePath
  return fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName
}

function summaryStatus(row: ProfileRow): string {
  if (row.loading) return "loading"
  if (row.usage?.error) return "error"
  return "ok"
}

function App() {
  const [rows, setRows] = useState<ProfileRow[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [statusLine, setStatusLine] = useState("Initializing...")
  const [lastRefresh, setLastRefresh] = useState("--")
  const [refreshing, setRefreshing] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [renameMode, setRenameMode] = useState<RenameMode | null>(null)
  const [deleteMode, setDeleteMode] = useState<DeleteMode | null>(null)
  const busyRef = useRef(false)

  const selectedRow = rows[selectedIndex] || null
  const activeRow = useMemo(() => rows.find((row) => row.profile.isActive) || null, [rows])
  const activeSaved = activeRow?.profile.source === "snapshot"

  const summaryHeader = useMemo(
    () => `${padRight("Sel", 4)} ${padRight("Profile", 20)} ${padRight("State", 9)} ${padRight("Plan", 7)} ${padRight("5h", 7)} ${padRight("7d", 7)} ${padRight("Codex", 7)} Status`,
    [],
  )

  const buildDefaultSaveName = useCallback(() => {
    const source = activeRow || selectedRow || rows[0] || null
    const email = source?.usage?.email || null
    const accountId = source?.profile.accountId || null
    if (email) return toSnapshotName(email)
    if (accountId) return toSnapshotName(accountId)
    return "openai-profile"
  }, [activeRow, rows, selectedRow])

  const refreshAll = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setRefreshing(true)
    setStatusLine("Refreshing profiles and usage...")

    try {
      const profiles = await provider.listProfiles()
      if (profiles.length === 0) {
        setRows([])
        setSelectedIndex(0)
        setLastRefresh("--")
        setStatusLine("No profiles found. Save one with a.")
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
      setStatusLine(errorCount === 0 ? `Loaded ${nextRows.length} profile(s)` : `Loaded ${nextRows.length} profile(s), ${errorCount} error(s)`)
    } catch (error) {
      setStatusLine(`Refresh failed: ${normalizeError(error)}`)
    } finally {
      busyRef.current = false
      setRefreshing(false)
    }
  }, [])

  const switchSelected = useCallback(async () => {
    if (refreshing || switching || saving || renaming || deleting) return
    const row = selectedRow
    if (!row) return
    if (row.profile.isActive) {
      setStatusLine(`${row.profile.name} is already active`)
      return
    }

    setSwitching(true)
    setStatusLine(`Switching active auth to ${row.profile.name}...`)
    try {
      await provider.switchToProfile(row.profile)
      await refreshAll()
      setStatusLine(`Switched active auth to ${row.profile.name}`)
    } catch (error) {
      setStatusLine(`Switch failed: ${normalizeError(error)}`)
    } finally {
      setSwitching(false)
    }
  }, [deleting, refreshAll, refreshing, renaming, saving, selectedRow, switching])

  const saveCurrentAuto = useCallback(async () => {
    if (refreshing || switching || saving || renaming || deleting) return
    const name = buildDefaultSaveName()
    setSaving(true)
    setStatusLine(`Saving current auth as ${name}...`)
    try {
      const result = await provider.saveCurrentProfile(name)
      const savedName = snapshotNameFromPath(result.path)
      await refreshAll()
      setStatusLine(result.overwritten ? `Updated snapshot ${savedName}` : `Saved snapshot ${savedName}`)
    } catch (error) {
      setStatusLine(`Save failed: ${normalizeError(error)}`)
    } finally {
      setSaving(false)
    }
  }, [buildDefaultSaveName, deleting, refreshAll, refreshing, renaming, saving, switching])

  const beginRename = useCallback(() => {
    if (!selectedRow) return
    if (selectedRow.profile.source !== "snapshot") {
      setStatusLine("Select a saved snapshot to rename")
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
      setStatusLine(`Renamed snapshot to ${targetName}`)
    } catch (error) {
      setStatusLine(`Rename failed: ${normalizeError(error)}`)
    } finally {
      setRenaming(false)
    }
  }, [refreshAll, renameMode])

  const beginDelete = useCallback(() => {
    if (!selectedRow) return
    if (selectedRow.profile.source !== "snapshot") {
      setStatusLine("Select a saved snapshot to delete")
      return
    }
    setRenameMode(null)
    setDeleteMode({ profile: selectedRow.profile })
    setStatusLine(`Delete ${selectedRow.profile.name}? Press y to confirm or n to cancel`)
  }, [selectedRow])

  const submitDelete = useCallback(async () => {
    if (!deleteMode) return
    setDeleting(true)
    try {
      await provider.deleteProfile(deleteMode.profile)
      const deletedName = deleteMode.profile.name
      setDeleteMode(null)
      await refreshAll()
      setStatusLine(`Deleted snapshot ${deletedName}`)
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
      void saveCurrentAuto()
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

  return (
    <box style={{ padding: 1, flexDirection: "column" }}>
      <box style={{ border: true, borderColor: "#7aa2f7", padding: 1, flexDirection: "column", marginBottom: 1 }}>
        <text content="sipmon" style={{ fg: "#7aa2f7" }} />
        <text content={`Provider: ${provider.label} | Last refresh: ${lastRefresh}`} style={{ fg: "#a9b1d6" }} />
        <text
          content={
            activeSaved
              ? `Active snapshot: ${activeRow?.profile.name || "--"}`
              : "Active snapshot: UNSAVED (press a to save current auth by email)"
          }
          style={{ fg: activeSaved ? "#9ece6a" : "#f7768e" }}
        />
        <text
          content={
            renameMode
              ? `Rename snapshot: ${renameMode.value || "<name>"} (Enter confirm, Esc cancel)`
              : deleteMode
                ? `Delete snapshot ${deleteMode.profile.name}? (y confirm, n cancel)`
                : "Keys: j/k move | s switch | a save current (email) | r rename | d delete | u refresh | q quit"
          }
          style={{ fg: "#bb9af7" }}
        />
        <text content={statusLine} style={{ fg: refreshing || switching || saving || renaming || deleting ? "#e0af68" : "#c0caf5" }} />
      </box>

      <box style={{ border: true, borderColor: "#414868", padding: 1, flexDirection: "column", marginBottom: 1 }}>
        <text content={summaryHeader} style={{ fg: "#7dcfff" }} />
        {rows.length === 0 ? (
          <text content="No profiles detected." style={{ fg: "#f7768e" }} />
        ) : (
          rows.map((row, index) => {
            const selected = index === selectedIndex
            const sel = `${selected ? ">" : " "}${row.profile.isActive ? "*" : " "}`
            const state = row.profile.isActive ? "active" : row.profile.source
            const plan = row.usage?.planType || "--"
            const p5 = remainingText(row.usage?.primary || null)
            const p7 = remainingText(row.usage?.secondary || null)
            const codex = remainingText(row.usage?.codexPrimary || null)
            const status = summaryStatus(row)
            const line = `${padRight(sel, 4)} ${truncate(row.profile.name, 20)} ${padRight(state, 9)} ${padRight(plan, 7)} ${padRight(p5, 7)} ${padRight(p7, 7)} ${padRight(codex, 7)} ${status}`
            const lineColor = row.usage?.error ? "#f7768e" : selected ? "#ffffff" : row.profile.isActive ? "#9ece6a" : "#c0caf5"
            return <text key={`${row.profile.source}:${row.profile.name}:${index}`} content={line} style={{ fg: lineColor }} />
          })
        )}
      </box>

      <box style={{ border: true, borderColor: "#565f89", padding: 1, flexDirection: "column" }}>
        {!selectedRow ? (
          <text content="No profile selected." style={{ fg: "#f7768e" }} />
        ) : (
          <>
            <text
              content={`Selected: ${selectedRow.profile.name} [${selectedRow.profile.isActive ? "active" : selectedRow.profile.source}] [${selectedRow.profile.authType}]`}
              style={{ fg: "#c0caf5" }}
            />
            <text
              content={`Plan: ${selectedUsage?.planType || "--"}  Email: ${selectedUsage?.email || "--"}  Account: ${selectedRow.profile.accountId || "--"}`}
              style={{ fg: "#a9b1d6" }}
            />
            <text
              content={`${padRight("Primary (5h)", 14)} ${formatBar(selectedUsage?.primary || null)}  reset ${formatDuration(selectedUsage?.primary?.resetAfterSeconds ?? null)}`}
              style={{ fg: metricColor(selectedUsage?.primary || null) }}
            />
            <text
              content={`${padRight("Weekly (7d)", 14)} ${formatBar(selectedUsage?.secondary || null)}  reset ${formatDuration(selectedUsage?.secondary?.resetAfterSeconds ?? null)}`}
              style={{ fg: metricColor(selectedUsage?.secondary || null) }}
            />
            {hasCodexData ? (
              selectedUsage?.codexAllowed === false ? (
                <text content={`${selectedCodexLabel}: unavailable on current plan`} style={{ fg: "#e0af68" }} />
              ) : (
                <>
                  <text
                    content={`${padRight(`${selectedCodexLabel} 5h`, 14)} ${formatBar(selectedUsage?.codexPrimary || null)}  reset ${formatDuration(selectedUsage?.codexPrimary?.resetAfterSeconds ?? null)}`}
                    style={{ fg: metricColor(selectedUsage?.codexPrimary || null) }}
                  />
                  <text
                    content={`${padRight(`${selectedCodexLabel} 7d`, 14)} ${formatBar(selectedUsage?.codexSecondary || null)}  reset ${formatDuration(selectedUsage?.codexSecondary?.resetAfterSeconds ?? null)}`}
                    style={{ fg: metricColor(selectedUsage?.codexSecondary || null) }}
                  />
                </>
              )
            ) : null}
            {hasCodeReviewData ? (
              selectedUsage?.codeReviewAllowed === false ? (
                <text content="Code review: unavailable on current plan" style={{ fg: "#e0af68" }} />
              ) : (
                <text
                  content={`${padRight("Code review", 14)} ${formatBar(selectedCodeReviewWindow)}  reset ${formatDuration(selectedCodeReviewWindow?.resetAfterSeconds ?? null)}`}
                  style={{ fg: metricColor(selectedCodeReviewWindow) }}
                />
              )
            ) : null}
            <text
              content={`Credits: ${selectedUsage?.creditsUnlimited ? "unlimited" : selectedUsage?.creditsBalance || "0"}`}
              style={{ fg: "#a9b1d6" }}
            />
            {selectedUsage?.error ? <text content={`Error: ${selectedUsage.error}`} style={{ fg: "#f7768e" }} /> : null}
          </>
        )}
      </box>
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
