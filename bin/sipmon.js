#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const bunBinary = process.env.BUN_BINARY || "bun"
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js")

const result = spawnSync(bunBinary, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
})

if (result.error) {
  if (result.error.code === "ENOENT") {
    console.error("sipmon requires Bun at runtime. Install Bun from https://bun.sh and retry.")
    process.exit(1)
  }
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
