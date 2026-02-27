import fs from "node:fs"

function packageVersion(): string {
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
  OPENCODE_AUTH_FILE
  OPENCODE_USAGE_PROFILES_DIR
  OPENCODE_OPENAI_PROFILES_DIR
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
