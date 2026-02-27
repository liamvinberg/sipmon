#!/bin/bash
set -euo pipefail

VERSION="${1:-}"
TAP_REPO="${2:-$HOME/personal/projects/homebrew-tap}"
ASSET_NAME="${3:-}"
FORMULA_PATH="$TAP_REPO/Formula/sipmon.rb"

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> [tap-repo-path] [asset-name]" >&2
  exit 1
fi

if [[ ! -d "$TAP_REPO/.git" ]]; then
  echo "Tap repo not found at $TAP_REPO" >&2
  exit 1
fi

if [[ -z "$ASSET_NAME" ]]; then
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH_RAW="$(uname -m)"
  case "$ARCH_RAW" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64) ARCH="x64" ;;
    *)
      echo "Unsupported architecture for default asset naming: $ARCH_RAW" >&2
      exit 1
      ;;
  esac
  ASSET_NAME="sipmon-${VERSION}-${OS}-${ARCH}.tar.gz"
fi

TAG="v$VERSION"
ASSET_URL="https://github.com/liamvinberg/sipmon/releases/download/$TAG/$ASSET_NAME"
TMP_TGZ="$(mktemp -t sipmon-release.XXXXXX.tgz)"
trap 'rm -f "$TMP_TGZ"' EXIT

curl -fsSL "$ASSET_URL" -o "$TMP_TGZ"
SHA256="$(shasum -a 256 "$TMP_TGZ" | awk '{print $1}')"

cat >"$FORMULA_PATH" <<EOF
class Sipmon < Formula
  desc "Terminal usage monitor and account switcher for AI providers"
  homepage "https://github.com/liamvinberg/sipmon"
  url "$ASSET_URL"
  sha256 "$SHA256"
  license "MIT"

  def install
    bin.install "sipmon"
  end

  test do
    assert_match "$VERSION", shell_output("#{bin}/sipmon --version")
  end
end
EOF

echo "Updated $FORMULA_PATH"
echo "Asset: $ASSET_URL"
echo "SHA256: $SHA256"
