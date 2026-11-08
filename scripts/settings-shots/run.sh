#!/usr/bin/env bash
# Settings screenshots against an ISOLATED daemon. Builds nothing: run `pnpm build` first.
#
#   PORT=3997 SCRATCH=/path/to/scratch scripts/settings-shots/run.sh <label> [section,section]
#
# 1. Makes a fresh fake HOME at $SCRATCH/settings-shots/home-$PORT (never the real ~/.dispatch).
# 2. Seeds files, starts the daemon from this worktree's packages/core/dist with this worktree's
#    packages/web/dist, seeds over the API, stops it, writes usage-limit rows into its DB, starts it again.
# 3. Shoots every section into $SCRATCH/settings-shots/<label>/, then stops the daemon it started.
# PORT and SCRATCH come from the environment so parallel workers do not collide.
set -euo pipefail

LABEL="${1:?usage: run.sh <label> [section,section]}"
ONLY="${2:-}"
PORT="${PORT:-3997}"
SCRATCH="${SCRATCH:?set SCRATCH to a scratch folder (for example your session scratchpad)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FAKE_HOME="$SCRATCH/settings-shots/home-$PORT"
OUT="$SCRATCH/settings-shots/$LABEL"
LOG="$SCRATCH/settings-shots/daemon-$PORT.log"
URL="http://localhost:$PORT"

[ -f "$ROOT/packages/core/dist/server.js" ] || { echo "no packages/core/dist: run pnpm build first" >&2; exit 1; }
[ -f "$ROOT/packages/web/dist/index.html" ] || { echo "no packages/web/dist: run pnpm build first" >&2; exit 1; }
case "$FAKE_HOME" in "$HOME"|"$HOME/") echo "refusing: the fake HOME is the real HOME" >&2; exit 1;; esac
if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is busy (another daemon?). Pick another: PORT=39xx" >&2; exit 1
fi

DAEMON_PID=""
start_daemon() {
  # env -u: a thread's own key must not leak into the test daemon.
  env -u DISPATCH_API -u DISPATCH_AUTH \
    HOME="$FAKE_HOME" PORT="$PORT" DISPATCH_TELEMETRY=0 DISPATCH_WEB_DIST="$ROOT/packages/web/dist" \
    node "$ROOT/packages/core/dist/server.js" >>"$LOG" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 120); do
    if curl -fsS "$URL/api/sessions" >/dev/null 2>&1; then return 0; fi
    kill -0 "$DAEMON_PID" 2>/dev/null || { echo "daemon exited; see $LOG" >&2; tail -n 30 "$LOG" >&2; exit 1; }
    sleep 0.5
  done
  echo "daemon did not answer on $URL; see $LOG" >&2; exit 1
}
stop_daemon() {
  # Only what this script started: its pid, that pid's children, and the listener on our port
  # (the port was free before we started, so the listener is ours).
  [ -n "$DAEMON_PID" ] || return 0
  local pids
  pids="$DAEMON_PID $(pgrep -P "$DAEMON_PID" 2>/dev/null || true) $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 80); do
    local alive=0
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ "$alive" = 1 ] || break
    sleep 0.25
  done
  kill -9 $pids 2>/dev/null || true
  wait "$DAEMON_PID" 2>/dev/null || true
  DAEMON_PID=""
}
trap stop_daemon EXIT

rm -rf "$FAKE_HOME"
mkdir -p "$FAKE_HOME" "$OUT"
: >"$LOG"

node "$HERE/seed.mjs" files "$FAKE_HOME"
start_daemon
# The owner token: a strict owner route wants a credential even from loopback.
SEED_HOME="$FAKE_HOME" node "$HERE/seed.mjs" api "$URL" "$FAKE_HOME/.dispatch/access-token"
stop_daemon
node "$HERE/seed.mjs" db "$FAKE_HOME"
start_daemon
sleep 2
node "$HERE/shoot.mjs" "$URL" "$OUT" "$ONLY"
stop_daemon
echo "screenshots: $OUT"
