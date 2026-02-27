#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="$(node -e 'const fs=require("fs");const pkg=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(pkg.version);' "$ROOT_DIR/package.json")"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_RAW="$(uname -m)"

case "$ARCH_RAW" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *)
    echo "Unsupported architecture: $ARCH_RAW" >&2
    exit 1
    ;;
esac

bash "$SCRIPT_DIR/build-binary.sh"

ARTIFACT="sipmon-${VERSION}-${OS}-${ARCH}.tar.gz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cp "$ROOT_DIR/dist/sipmon" "$TMP_DIR/sipmon"
chmod +x "$TMP_DIR/sipmon"
tar -C "$TMP_DIR" -czf "$ROOT_DIR/dist/$ARTIFACT" sipmon

SHA256="$(shasum -a 256 "$ROOT_DIR/dist/$ARTIFACT" | awk '{print $1}')"
echo "Built release artifact: $ROOT_DIR/dist/$ARTIFACT"
echo "SHA256: $SHA256"
