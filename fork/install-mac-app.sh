#!/usr/bin/env bash
# Rebuild this fork's desktop app and replace the installed copy. Run it on the Mac.
#
#   fork/install-mac-app.sh            pull, build, install, relaunch
#   fork/install-mac-app.sh --no-pull  build what is checked out
#
# It builds only the .app (no DMG or zip) and uses the Node version package.json pins,
# because an nvm or Homebrew Node found first on PATH cannot run the build scripts.
set -euo pipefail

cd "$(dirname "$0")/.."

pull=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) pull=0 ;;
    -h | --help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

vp_home="$HOME/.local/share/vite-plus"
node_version="$(sed -n 's/.*"node": *"\([0-9.]*\)".*/\1/p' package.json | head -1)"
export PATH="$vp_home/js_runtime/node/$node_version/bin:$vp_home/bin:$PATH"
command -v vp >/dev/null || {
  echo "vp is missing; install Vite+ with: curl -fsSL https://vite.plus | bash" >&2
  exit 1
}
[ -x "$vp_home/js_runtime/node/$node_version/bin/node" ] || vp env install "$node_version"

if [ "$pull" = 1 ]; then git pull --ff-only; fi
vp i
vp run dist:desktop:artifact --platform mac --target dir --arch arm64

built="$(find release -maxdepth 2 -name '*.app' -type d -print -quit)"
[ -n "$built" ] || {
  echo "no .app under release/" >&2
  exit 1
}
name="$(basename "$built")"
installed="/Applications/$name"

# pgrep -x misses truncated macOS process names and pgrep -f reads "(Beta)" as a regex, so
# match the executable path (comm, which also leaves out this grep) literally.
running() { ps -axo comm= | grep -qF "$installed/Contents/"; }
if running; then
  echo "quitting $name"
  osascript -e "quit app \"${name%.app}\"" || true
  for _ in $(seq 1 30); do
    running || break
    sleep 1
  done
  if running; then
    echo "$name is still running; quit it and run this again" >&2
    exit 1
  fi
fi

rm -rf "$installed"
ditto "$built" "$installed"
echo "installed $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$installed/Contents/Info.plist") at $installed ($(git rev-parse --short HEAD))"
open "$installed"
