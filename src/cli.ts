import fs from "node:fs"

declare const SIPMON_VERSION: string | undefined

function packageVersion(): string {
  if (typeof SIPMON_VERSION === "string" && SIPMON_VERSION.trim().length > 0) {
    return SIPMON_VERSION
  }

  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version || "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function printHelp() {
  console.log(`sipmon ${packageVersion()}

Usage:
  sipmon
  sipmon --help
  sipmon --version

Environment:
  SIPMON_DATA_DIR
  SIPMON_AUTH_FILE
  SIPMON_PROFILES_DIR
  SIPMON_OPENAI_PROFILES_DIR
  SIPMON_REPLICATION_TARGETS
  OPENCODE_AUTH_FILE
`)
}

const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  printHelp()
  process.exit(0)
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(packageVersion())
  process.exit(0)
}

if (args.length > 0) {
  console.error(`Unknown argument(s): ${args.join(" ")}`)
  console.error("Run 'sipmon --help' for usage.")
  process.exit(1)
}

await import("./main.js")
