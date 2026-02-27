#!/bin/bash
set -euo pipefail

VERSION="${1:-}"
TAP_REPO="${2:-$HOME/personal/projects/homebrew-tap}"
FORMULA_PATH="$TAP_REPO/Formula/sipmon.rb"

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> [tap-repo-path]" >&2
  exit 1
fi

if [[ ! -d "$TAP_REPO/.git" ]]; then
  echo "Tap repo not found at $TAP_REPO" >&2
  exit 1
fi

TARBALL_URL="https://registry.npmjs.org/sipmon/-/sipmon-$VERSION.tgz"
TMP_TGZ="$(mktemp -t sipmon-tarball.XXXXXX.tgz)"
trap 'rm -f "$TMP_TGZ"' EXIT

curl -fsSL "$TARBALL_URL" -o "$TMP_TGZ"
SHA256="$(shasum -a 256 "$TMP_TGZ" | awk '{print $1}')"

cat >"$FORMULA_PATH" <<EOF
class Sipmon < Formula
  desc "Terminal usage monitor and account switcher for AI providers"
  homepage "https://github.com/liamvinberg/sipmon"
  url "$TARBALL_URL"
  sha256 "$SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/sipmon"
  end

  test do
    assert_match "$VERSION", shell_output("#{bin}/sipmon --version")
  end
end
EOF

echo "Updated $FORMULA_PATH"
echo "Tarball: $TARBALL_URL"
echo "SHA256: $SHA256"
