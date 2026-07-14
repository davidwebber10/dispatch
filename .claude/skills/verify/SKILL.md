---
name: verify
description: Launch an isolated dispatch daemon and drive its HTTP/WS surface to verify core changes end-to-end
---

# Verifying dispatch core changes

Never point a second daemon at the real `~/.dispatch` — always use a fake HOME.

## Build + launch (isolated)

```bash
pnpm build   # or: pnpm --filter dispatch-server build for core only
mkdir -p <scratch>/fake-home
HOME=<scratch>/fake-home PORT=3999 node packages/core/dist/server.js > <scratch>/daemon.log 2>&1 &
```

Ready when the log prints `Dispatch server listening on port 3999`. No auth on the API.
Teardown: `lsof -ti :3999 | xargs kill`.

**Running from a git worktree:** the daemon can resolve its web bundle to the MAIN
checkout's `packages/web/dist` (stale code, no error). Always pass
`DISPATCH_WEB_DIST=<worktree>/packages/web/dist` and confirm the log's
"Serving web client from" line points into the worktree.

## Drive the surface

```bash
# Create a session, then a cheap shell terminal (spawns a real PTY, no CLI login needed)
SID=$(curl -s -X POST :3999/api/sessions -H 'Content-Type: application/json' \
  -d '{"provider":"claude-code","name":"verify","workingDir":"/tmp"}' | jq -r .id)
TID=$(curl -s -X POST :3999/api/sessions/$SID/terminals -H 'Content-Type: application/json' \
  -d '{"type":"shell","label":"sh"}' | jq -r .id)

# Read state
curl -s :3999/api/sessions | jq          # session status/lastActivityAt
curl -s :3999/api/terminals/$TID | jq    # terminal row

# Simulate Claude hook lifecycle events (SessionStart/UserPromptSubmit/Stop/Notification)
curl -X POST :3999/api/events/claude/$TID -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"Stop","session_id":"sid-x"}'   # → 204 always

# Stop
curl -X POST :3999/api/sessions/$SID/stop
```

Terminal WebSocket (attach = what "opening a thread" does): `ws://127.0.0.1:3999/api/terminals/<TID>/ws?replayBytes=1000000`. Input is sent raw; resize is JSON `{"type":"resize","cols":N,"rows":N}`. From a scratch-dir node script, resolve the `ws` package via `createRequire('<repo>/packages/core/package.json')('ws')` — plain `import 'ws'` won't resolve outside the repo.

## Gotchas

- The TerminalMonitor has a 5s connection-grace window after spawn/attach and a 500-byte busy threshold; time activity-related assertions ~6s past attach, and wait ≥4s after output for the 3s idle timer to fire.
- Run vitest from inside `packages/core` or `packages/web` (`npx vitest run`) — running from the repo root picks up web tests without their jsdom config and mass-fails them.
