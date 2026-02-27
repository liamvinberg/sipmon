import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { providers } from "./providers"
import type { ProfileUsage, ProviderProfile, UsageWindow } from "./providers/types"

const provider = providers[0]
const BAR_WIDTH = 26

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

function clampPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
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
  const percent = clampPercent(window?.usedPercent ?? null)
  if (percent === null) {
    return `[${"-".repeat(BAR_WIDTH)}]  --%`
  }
  const filled = Math.round((percent / 100) * BAR_WIDTH)
  const bar = `${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}`
  return `[${bar}] ${String(Math.round(percent)).padStart(3, " ")}%`
}

function formatStatus(row: ProfileRow): string {
  if (row.loading) return "loading"
  if (row.usage?.error) return "error"
  return "ok"
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

function App() {
  const [rows, setRows] = useState<ProfileRow[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [statusLine, setStatusLine] = useState("Initializing...")
  const [lastRefresh, setLastRefresh] = useState("--")
  const [refreshing, setRefreshing] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMode, setSaveMode] = useState(false)
  const [saveInput, setSaveInput] = useState("")
  const busyRef = useRef(false)

  const selectedRow = rows[selectedIndex] || null

  const activeSnapshot = useMemo(() => {
    return rows.find((row) => row.profile.source === "snapshot" && row.profile.isActive) || null
  }, [rows])

  const activeSaved = Boolean(activeSnapshot)

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
        setStatusLine("No profiles found. Save one with opencode-openai-profile or press a in this UI.")
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
      const nextRows: ProfileRow[] = profiles.map((profile, index) => ({
        profile,
        usage: usageList[index],
        loading: false,
      }))

      const errorCount = nextRows.filter((row) => row.usage?.error).length
      setRows(nextRows)
      setSelectedIndex((index) => Math.max(0, Math.min(index, nextRows.length - 1)))
      setLastRefresh(new Date().toLocaleTimeString())
      if (errorCount === 0) {
        setStatusLine(`Loaded ${nextRows.length} profile(s)`)
      } else {
        setStatusLine(`Loaded ${nextRows.length} profile(s), ${errorCount} failed`)
      }
    } catch (error) {
      setStatusLine(`Refresh failed: ${normalizeError(error)}`)
    } finally {
      busyRef.current = false
      setRefreshing(false)
    }
  }, [])

  const switchSelected = useCallback(async () => {
    if (refreshing || switching || saving) return
    const row = selectedRow
    if (!row) return
    if (row.profile.source === "current") {
      setStatusLine("@active already points to the current auth entry")
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
  }, [refreshAll, refreshing, saving, selectedRow, switching])

  const saveCurrent = useCallback(
    async (name: string) => {
      if (refreshing || switching || saving) return
      setSaving(true)
      setStatusLine(`Saving current auth as ${name}...`)

      try {
        const result = await provider.saveCurrentProfile(name)
        await refreshAll()
        setSaveMode(false)
        setSaveInput("")
        setStatusLine(result.overwritten ? `Updated snapshot ${name}` : `Saved snapshot ${name}`)
      } catch (error) {
        setStatusLine(`Save failed: ${normalizeError(error)}`)
      } finally {
        setSaving(false)
      }
    },
    [refreshAll, refreshing, saving, switching],
  )

  useKeyboard((rawKey) => {
    const key = rawKey as KeyboardEventLike

    if (saveMode) {
      if (key.name === "escape") {
        setSaveMode(false)
        setSaveInput("")
        setStatusLine("Save cancelled")
        return
      }

      if (key.name === "return") {
        const name = saveInput.trim()
        if (!name) {
          setStatusLine("Snapshot name is required")
          return
        }
        void saveCurrent(name)
        return
      }

      if (key.name === "backspace" || key.name === "delete") {
        setSaveInput((value) => value.slice(0, -1))
        return
      }

      const char = extractInputCharacter(key)
      if (char && saveInput.length < 40) {
        setSaveInput((value) => value + char)
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

    if (key.name === "r" && !key.repeated) {
      void refreshAll()
      return
    }

    if ((key.name === "s" || key.name === "return") && !key.repeated) {
      void switchSelected()
      return
    }

    if (key.name === "a" && !key.repeated) {
      setSaveMode(true)
      setSaveInput("")
      setStatusLine("Type snapshot name and press Enter")
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

  return (
    <box style={{ padding: 1, flexDirection: "column" }}>
      <box style={{ border: true, padding: 1, flexDirection: "column", marginBottom: 1 }}>
        <text content="OpenCode Usage + Account Switcher" style={{ fg: "#7aa2f7" }} />
        <text content={`Provider: ${provider.label} | Last refresh: ${lastRefresh}`} style={{ fg: "#a9b1d6" }} />
        <text
          content={
            activeSaved
              ? `Active snapshot: ${activeSnapshot?.profile.name || "--"}`
              : "Active snapshot: UNSAVED (press a to save current auth)"
          }
          style={{ fg: activeSaved ? "#9ece6a" : "#f7768e" }}
        />
        <text content={statusLine} style={{ fg: refreshing || switching || saving ? "#e0af68" : "#c0caf5" }} />
        <text
          content={
            saveMode
              ? `Save current as: ${saveInput || "<name>"}  (Enter confirm, Esc cancel)`
              : "Keys: j/k or arrows move | s/Enter switch | a save current | r refresh | q quit"
          }
          style={{ fg: "#bb9af7" }}
        />
      </box>

      {rows.length === 0 ? (
        <text content="No profiles detected." style={{ fg: "#f7768e" }} />
      ) : (
        rows.map((row, index) => {
          const selected = index === selectedIndex
          const headerPrefix = `${selected ? ">" : " "}${row.profile.isActive ? "*" : " "}`
          const rowStatus = formatStatus(row)
          const rowColor = row.usage?.error ? "#f7768e" : selected ? "#ffffff" : "#c0caf5"
          const sourceLabel = row.profile.source === "snapshot" ? "snapshot" : "active"
          const usage = row.usage

          return (
            <box
              key={`${row.profile.source}:${row.profile.name}:${index}`}
              style={{
                border: true,
                padding: 1,
                marginBottom: 1,
                backgroundColor: selected ? "#1f2335" : undefined,
                flexDirection: "column",
              }}
            >
              <text
                content={`${headerPrefix} ${row.profile.name}  [${sourceLabel}]  [${row.profile.authType}]  [${rowStatus}]`}
                style={{ fg: rowColor }}
              />
              <text
                content={`Plan: ${usage?.planType || "--"}  Email: ${usage?.email || "--"}  Account: ${row.profile.accountId || "--"}`}
                style={{ fg: rowColor }}
              />
              <text
                content={`Primary ${formatBar(usage?.primary || null)}  reset ${formatDuration(usage?.primary?.resetAfterSeconds ?? null)}`}
                style={{ fg: rowColor }}
              />
              <text
                content={`Weekly  ${formatBar(usage?.secondary || null)}  reset ${formatDuration(usage?.secondary?.resetAfterSeconds ?? null)}`}
                style={{ fg: rowColor }}
              />
              <text
                content={`Codex   ${formatBar(usage?.codexPrimary || null)}  reset ${formatDuration(usage?.codexPrimary?.resetAfterSeconds ?? null)}`}
                style={{ fg: rowColor }}
              />
              {usage?.error ? <text content={`Error: ${usage.error}`} style={{ fg: "#f7768e" }} /> : null}
            </box>
          )
        })
      )}
    </box>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<App />)
