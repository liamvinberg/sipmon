#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js")
await import(pathToFileURL(entry).href)
