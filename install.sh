#!/bin/bash
set -euo pipefail

TAP="liamvinberg/tap"
FORMULA="sipmon"
REPO="liamvinberg/sipmon"
INSTALL_DIR="${SIPMON_INSTALL_DIR:-$HOME/.local/bin}"

if command -v brew >/dev/null 2>&1; then
  brew tap "$TAP" >/dev/null 2>&1 || true
  if brew list --formula "$TAP/$FORMULA" >/dev/null 2>&1; then
    brew upgrade "$TAP/$FORMULA" || true
  else
    brew install "$TAP/$FORMULA"
  fi
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install sipmon without Homebrew." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to parse GitHub release metadata." >&2
  exit 1
fi

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

LATEST_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")"
TAG="$(printf '%s' "$LATEST_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
VERSION="${TAG#v}"
ASSET="sipmon-${VERSION}-${OS}-${ARCH}.tar.gz"
URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL "$URL" -o "$TMP_DIR/sipmon.tgz"
tar -xzf "$TMP_DIR/sipmon.tgz" -C "$TMP_DIR"

mkdir -p "$INSTALL_DIR"
install -m 755 "$TMP_DIR/sipmon" "$INSTALL_DIR/sipmon"

echo "Installed sipmon $VERSION to $INSTALL_DIR/sipmon"
echo "Ensure $INSTALL_DIR is in your PATH."
