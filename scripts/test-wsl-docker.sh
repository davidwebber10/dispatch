#!/usr/bin/env bash
# Tier-2 integration harness: proves the request -> platform -> interop pipeline for the WSL
# flavor on REAL Linux, inside a throwaway Docker container, using fake wslpath/explorer.exe
# shims (scripts/wsl-sim/*) instead of a real Windows host. See .claude/skills/verify/SKILL.md
# for the curl recipe this mirrors.
#
# The container is the only thing that installs/builds: the host repo is mounted read-only at
# /repo-src and copied (excluding node_modules/.git, which contain darwin-native binaries and
# worktree-relative git plumbing that don't belong on Linux) into /work, where a fresh
# pnpm install + build happens entirely inside the container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="node:22-bookworm"
CONTAINER_NAME="dispatch-wsl-sim-$$"

cleanup() { docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "WSL-SIM: launching $IMAGE (repo-side pnpm install + build happens inside; this takes a bit)..."

docker run --rm -i --name "$CONTAINER_NAME" \
  -v "$REPO_ROOT:/repo-src:ro" \
  -e WSL_DISTRO_NAME=Ubuntu \
  -e WSL_SIM_LOG=/tmp/simlog \
  -e PORT=3999 \
  -e DISPATCH_WEB_DIST=/work/packages/web/dist \
  -e WSL_INTEROP=/run/WSL/fake \
  "$IMAGE" bash -s <<'INNER'
# WSL_INTEROP above is load-bearing: this is a plain Debian container with no real
# /proc/sys/fs/binfmt_misc/WSLInterop, so the wsl platform's interop probe (see
# packages/core/src/platform/wsl.ts) would otherwise fall through to
# fileManagerName === null and every reveal assertion below would fail. Setting
# WSL_INTEROP is the documented fallback path for that same probe, so it keeps this
# harness asserting the interop-present path it's actually meant to exercise.
set -euo pipefail

fail() { echo "WSL-SIM FAIL: $*" >&2; exit 1; }

mkdir -p /work
tar -C /repo-src -cf - --exclude=node_modules --exclude=.git . | tar -C /work -xf -
cd /work

corepack enable
pnpm install --frozen-lockfile
pnpm -r run build
[ -f packages/core/dist/server.js ] || fail "build did not produce packages/core/dist/server.js"

export PATH="/work/scripts/wsl-sim:$PATH"
export HOME=/work/fake-home
mkdir -p "$HOME"
touch "$WSL_SIM_LOG"

node packages/core/dist/server.js > /tmp/daemon.log 2>&1 &
DAEMON_PID=$!

ready=0
for i in $(seq 1 30); do
  if curl -sf http://localhost:3999/api/state/host >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = "1" ] || { cat /tmp/daemon.log >&2; fail "daemon never became ready on :3999"; }

# GET /api/state/host reports the fake-WSL platform correctly
HOST_JSON="$(curl -s http://localhost:3999/api/state/host)"
echo "$HOST_JSON" | grep -q '"flavor":"wsl"' || fail "host.flavor != wsl: $HOST_JSON"
echo "$HOST_JSON" | grep -q '"fileManagerName":"File Explorer"' || fail "host.fileManagerName wrong: $HOST_JSON"
echo "$HOST_JSON" | grep -q '"canReveal":true' || fail "host.canReveal not true: $HOST_JSON"

# A session + a real reveal round-trips through wslpath -> explorer.exe shims
SESSION_JSON="$(curl -s -X POST http://localhost:3999/api/sessions -H 'Content-Type: application/json' \
  -d '{"provider":"claude-code","name":"wsl-sim","workingDir":"/tmp"}')"
SID="$(printf '%s' "$SESSION_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).id||'')")"
[ -n "$SID" ] || fail "no session id from: $SESSION_JSON"

echo "reveal me" > /tmp/wsl-sim-reveal.txt
REVEAL_STATUS="$(curl -s -o /tmp/reveal-body -w '%{http_code}' -X POST \
  "http://localhost:3999/api/sessions/$SID/files/reveal" \
  -H 'Content-Type: application/json' -H 'Host: localhost:3999' \
  -d '{"paths":["wsl-sim-reveal.txt"]}')"
[ "$REVEAL_STATUS" = "200" ] || fail "reveal returned $REVEAL_STATUS: $(cat /tmp/reveal-body)"

grep -q 'wslpath -w' "$WSL_SIM_LOG" || fail "simlog missing a 'wslpath -w' call: $(cat "$WSL_SIM_LOG")"
grep -q 'explorer.exe /select,C:' "$WSL_SIM_LOG" || fail "simlog missing 'explorer.exe /select,C:': $(cat "$WSL_SIM_LOG")"

# The /mnt/* working-dir warning fires regardless of the reveal path above
MNT_JSON="$(curl -s -X POST http://localhost:3999/api/sessions -H 'Content-Type: application/json' \
  -d '{"provider":"claude-code","name":"mnt-sim","workingDir":"/mnt/c/x"}')"
echo "$MNT_JSON" | grep -q '"warning"' || fail "no warning for /mnt/* workingDir: $MNT_JSON"

kill "$DAEMON_PID" 2>/dev/null || true
echo "WSL-SIM: all assertions passed"
INNER
