#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) {
    return null
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function toVersion(parts) {
  return `${parts.major}.${parts.minor}.${parts.patch}`
}

function bump(parts, releaseType) {
  switch (releaseType) {
    case "patch":
      return { major: parts.major, minor: parts.minor, patch: parts.patch + 1 }
    case "minor":
      return { major: parts.major, minor: parts.minor + 1, patch: 0 }
    case "major":
      return { major: parts.major + 1, minor: 0, patch: 0 }
    default:
      return null
  }
}

function printUsage() {
  console.log(`Usage:
  node scripts/bump-version.mjs <patch|minor|major>
  node scripts/bump-version.mjs --set <x.y.z>

Examples:
  bun run version:patch
  bun run version:minor
  bun run version:major
  bun run version:bump -- --set 2.0.0`)
}

const args = process.argv.slice(2)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, "..")
const packageJsonPath = path.join(rootDir, "package.json")

const packageRaw = fs.readFileSync(packageJsonPath, "utf8")
const packageJson = JSON.parse(packageRaw)
const previousVersion = packageJson.version

const currentParsed = parseVersion(previousVersion)
if (!currentParsed) {
  console.error(`Current version is not valid semver: ${String(previousVersion)}`)
  process.exit(1)
}

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  printUsage()
  process.exit(args.length === 0 ? 1 : 0)
}

let targetVersion = null

if (args[0] === "--set") {
  const candidate = args[1]
  const parsed = candidate ? parseVersion(candidate) : null
  if (!parsed) {
    console.error("Invalid version for --set. Expected format x.y.z")
    process.exit(1)
  }
  targetVersion = toVersion(parsed)
} else {
  const releaseType = args[0]
  if (!releaseType || !["patch", "minor", "major"].includes(releaseType)) {
    console.error(`Unknown release type: ${releaseType || "(empty)"}`)
    printUsage()
    process.exit(1)
  }

  const nextParsed = bump(currentParsed, releaseType)
  if (!nextParsed) {
    console.error(`Unable to compute next version for release type: ${releaseType}`)
    process.exit(1)
  }

  targetVersion = toVersion(nextParsed)
}

if (previousVersion === targetVersion) {
  console.log(`Version already set to ${targetVersion}`)
  process.exit(0)
}

packageJson.version = targetVersion
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")

const bunInstall = spawnSync("bun", ["install", "--lockfile-only"], {
  cwd: rootDir,
  stdio: "inherit",
})

if (bunInstall.status !== 0) {
  console.error("Failed to refresh bun.lock with `bun install --lockfile-only`.")
  process.exit(bunInstall.status || 1)
}

console.log(`Updated version: ${previousVersion} -> ${targetVersion}`)
console.log("Updated lockfile: bun.lock")
