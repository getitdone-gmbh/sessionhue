#!/bin/bash
# sessionhue installer: installs the CLI from the latest GitHub release,
# then runs the guided setup. Used by the one-line install command and by
# the double-click "Install sessionhue.command" from the release.
set -euo pipefail

TGZ="${SESSIONHUE_TGZ:-https://github.com/getitdone-gmbh/sessionhue/releases/latest/download/sessionhue.tgz}"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Started from Finder, PATH is minimal: pick up Homebrew and nvm if present.
for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$brew" ] && eval "$("$brew" shellenv)" && break
done
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # nvm is not compatible with strict mode.
  set +eu
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  set -eu
fi

has_node() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]
}

bold "sessionhue · terminal session colors"

if ! has_node; then
  if command -v brew >/dev/null 2>&1; then
    bold "sessionhue needs Node.js 18 or newer. Installing it with Homebrew..."
    brew install node
  else
    echo "sessionhue needs Node.js 18 or newer."
    echo "Install it from https://nodejs.org (or Homebrew from https://brew.sh) and run this again."
    exit 1
  fi
fi

bold "Installing sessionhue..."
if ! npm install -g "$TGZ"; then
  echo
  echo "npm could not install sessionhue globally."
  echo "For permission errors see https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
  exit 1
fi

if [ -n "${SESSIONHUE_SKIP_SETUP:-}" ]; then
  exit 0
fi

bold "Setting up..."
# Read answers from the keyboard even when this script was piped in.
sessionhue setup </dev/tty
