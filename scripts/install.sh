#!/usr/bin/env bash
# Dispatch one-line installer.
#   Remote:  curl -fsSL <public-url>/scripts/install.sh | sh
#   Local:   ./scripts/install.sh
set -uo pipefail

REPO_URL="${DISPATCH_REPO_URL:-https://github.com/davidwebber10/dispatch.git}"
APP_DIR="${DISPATCH_APP_DIR:-$HOME/.dispatch/app}"
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

red() { printf '\033[31m%s\033[0m\n' "$1" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
bold() { printf '\033[1m%s\033[0m\n' "$1"; }

case "$(uname)" in
  Darwin|Linux) ;;
  *) red "Dispatch supports macOS and Linux/WSL2 (on Windows, run scripts/install-windows.ps1)."; exit 1 ;;
esac
command -v git >/dev/null 2>&1 || { red "git not found — install Xcode Command Line Tools: xcode-select --install"; exit 1; }
command -v node >/dev/null 2>&1 || { red "Node.js 18+ not found — install from https://nodejs.org and retry."; exit 1; }
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then corepack enable >/dev/null 2>&1 || true; fi
  command -v pnpm >/dev/null 2>&1 || { red "pnpm not found — run: npm i -g pnpm   (or: corepack enable)"; exit 1; }
fi

if $CHECK_ONLY; then green "Prerequisites OK (macOS, git, node, pnpm)."; exit 0; fi

# If we're already inside a checkout (local run), use it; otherwise clone.
SELF_REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || true)"
if [ -n "$SELF_REPO" ] && [ -f "$SELF_REPO/bin/dispatch" ]; then
  TARGET="$SELF_REPO"
else
  bold "Cloning Dispatch → $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  if [ -d "$APP_DIR/.git" ]; then ( cd "$APP_DIR" && git pull --ff-only ); else git clone "$REPO_URL" "$APP_DIR"; fi
  TARGET="$APP_DIR"
fi

bold "Building + installing the daemon…"
( cd "$TARGET" && ./bin/dispatch build && ./bin/dispatch install ) || { red "Install failed."; exit 1; }

# Best-effort: put `dispatch` on PATH (non-fatal).
for d in /usr/local/bin "$HOME/.local/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then ln -sf "$TARGET/bin/dispatch" "$d/dispatch" && break; fi
done

green "Dispatch is running → http://localhost:3456"
command -v open >/dev/null 2>&1 && open "http://localhost:3456" || true
echo "Next: the in-app wizard will walk you through agents, mobile (Tailscale), and secrets."
