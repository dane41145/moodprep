#!/usr/bin/env bash
# Rebuild MoodPrep from the current source, install it, and open it.
#
#   ./scripts/relaunch.sh          rebuild, replace /Applications/MoodPrep.app, open it
#   ./scripts/relaunch.sh --here   rebuild and open from release/ without touching /Applications
#
# Installing is the default on purpose. Two bundles on disk share the
# com.moodprep.app identifier, so macOS LaunchServices is free to front either
# one — which is exactly how an hours-old build ends up on screen looking like
# the current source. Keeping /Applications the single copy removes the choice.
#
# The bundle is built with electron-builder's --dir mode, so there is no DMG or
# ZIP: it takes seconds rather than the minutes package:mac needs.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
STAGED="$ROOT/release/mac-arm64/MoodPrep.app"
INSTALLED="/Applications/MoodPrep.app"
INSTALL=1
[ "${1:-}" = "--here" ] && INSTALL=0

quit_bundle() {
  local target="$1"
  pgrep -f "$target/Contents/MacOS/MoodPrep" >/dev/null 2>&1 || return 0
  echo "==> Quitting the running copy at $target"
  pkill -f "$target/Contents/MacOS/MoodPrep" || true
  for _ in $(seq 1 20); do
    pgrep -f "$target/Contents/MacOS/MoodPrep" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  echo "That copy is still running; close it and try again." >&2
  exit 1
}

echo "==> Typechecking and building the renderer"
npm run build

quit_bundle "$STAGED"
[ "$INSTALL" = "1" ] && quit_bundle "$INSTALLED"

echo "==> Packaging the app bundle"
npx electron-builder --mac --dir

VERSION="$(node -p "require('$ROOT/package.json').version")"

if [ "$INSTALL" = "1" ]; then
  if [ -d "$INSTALLED" ]; then
    # Keep the outgoing build the way every previous install was kept.
    OUTGOING="$(defaults read "$INSTALLED/Contents/Info.plist" CFBundleShortVersionString)"
    PREVIOUS="$ROOT/release/MoodPrep-previous-$OUTGOING-installed.app"
    echo "==> Setting the outgoing $OUTGOING build aside as $(basename "$PREVIOUS")"
    # Only the one outgoing build is kept. Keeping every one of them is how
    # release/ reached 18 GB of 308 MB bundles by 2026-09-09.
    rm -rf "$ROOT"/release/MoodPrep-previous-*.app
    mv "$INSTALLED" "$PREVIOUS"
  fi
  echo "==> Installing $VERSION to /Applications"
  cp -R "$STAGED" "$INSTALLED"
  # Only one com.moodprep.app may remain, or LaunchServices can front the wrong
  # one and hand back a build that does not match the source.
  rm -rf "$STAGED"
  TARGET="$INSTALLED"
else
  TARGET="$STAGED"
fi

open "$TARGET"
echo "==> Opened MoodPrep $VERSION at $TARGET"

# State plainly which bundle actually came up, so a stale window is never
# mistaken for a fresh one again.
sleep 2
echo "==> Now running:"
pgrep -fl "MoodPrep.app/Contents/MacOS/MoodPrep" | sed 's/^/    /' || echo "    (nothing yet — the app may still be starting)"
