#!/usr/bin/env bash
# Installs or updates CodeDen Fork on this Mac from the fork's latest GitHub release.
#   curl -fsSL https://github.com/jonathansaurens/codeden/releases/latest/download/install-macos.sh | bash
# The build isn't signed with an Apple Developer ID; downloading it with curl (not a browser)
# means macOS doesn't quarantine it, so it opens without a Gatekeeper prompt.
set -euo pipefail
REPO=jonathansaurens/codeden
ARCH=$(uname -m); [ "$ARCH" = arm64 ] || ARCH=x64
echo "Finding the latest CodeDen Fork release…"
JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")
URL=$(printf '%s' "$JSON" | grep -o "\"browser_download_url\": *\"[^\"]*CodeDen-Fork-[^\"]*-$ARCH\.dmg\"" | sed 's/.*"\(https[^"]*\)"/\1/' | head -1)
TAG=$(printf '%s' "$JSON" | grep -o '"tag_name": *"[^"]*"' | sed 's/.*"\(v[^"]*\)"/\1/')
[ -n "$URL" ] || { echo "No $ARCH build in the latest release ($TAG)."; exit 1; }
TMP=$(mktemp -d); trap 'hdiutil detach -quiet "$TMP/mnt" 2>/dev/null || true; rm -rf "$TMP"' EXIT
echo "Downloading $TAG for $ARCH…"
curl -fL --progress-bar -o "$TMP/app.dmg" "$URL"
if pgrep -f "/CodeDen Fork.app/Contents/MacOS/" >/dev/null; then
  echo "Quitting CodeDen Fork…"; osascript -e 'quit app "CodeDen Fork"' || true
  for _ in $(seq 30); do pgrep -f "/CodeDen Fork.app/Contents/MacOS/" >/dev/null || break; sleep 1; done
fi
mkdir "$TMP/mnt"; hdiutil attach -quiet -nobrowse -mountpoint "$TMP/mnt" "$TMP/app.dmg"
rm -rf "/Applications/CodeDen Fork.app"
ditto "$TMP/mnt/CodeDen Fork.app" "/Applications/CodeDen Fork.app"
xattr -dr com.apple.quarantine "/Applications/CodeDen Fork.app" 2>/dev/null || true
echo "Installed CodeDen Fork $TAG in /Applications."
pgrep -f "/Applications/CodeDen.app/Contents/MacOS/" >/dev/null && echo "Note: the official CodeDen is running; quit it before opening CodeDen Fork (they share ~/.codeden)." || open "/Applications/CodeDen Fork.app"
