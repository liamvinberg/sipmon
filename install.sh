#!/bin/bash
set -euo pipefail

TAP="liamvinberg/tap"
FORMULA="sipmon"
PACKAGE="sipmon"

if command -v brew >/dev/null 2>&1; then
  brew tap "$TAP" >/dev/null 2>&1 || true
  if brew list --formula "$TAP/$FORMULA" >/dev/null 2>&1; then
    brew upgrade "$TAP/$FORMULA" || true
  else
    brew install "$TAP/$FORMULA"
  fi
  exit 0
fi

if command -v npm >/dev/null 2>&1; then
  npm install -g "$PACKAGE"
  exit 0
fi

echo "Homebrew or npm is required to install sipmon." >&2
exit 1
