#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="$(node -e 'const fs=require("fs");const pkg=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(pkg.version);' "$ROOT_DIR/package.json")"

mkdir -p "$ROOT_DIR/dist"

bun build "$ROOT_DIR/src/cli.ts" \
  --compile \
  --outfile "$ROOT_DIR/dist/sipmon" \
  --define "SIPMON_VERSION=\"$VERSION\""

echo "Built binary: $ROOT_DIR/dist/sipmon ($VERSION)"
