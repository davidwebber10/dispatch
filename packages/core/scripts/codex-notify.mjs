#!/usr/bin/env node
// Codex `notify` helper. Registered per-session via:
//   -c notify=["node", "<this file>", "<events-url>"]
// Codex runs the program on lifecycle events (agent-turn-complete,
// approval-requested, ...) and APPENDS the event JSON as the final argv arg.
// So argv is: [node, thisFile, <events-url>, <payload-json>].
// We forward the payload to the events route, which normalizes it and captures
// the thread-id. Best-effort and silent — a failed notify must never disrupt Codex.

const url = process.argv[2];
const payload = process.argv[process.argv.length - 1];

if (!url || !payload || payload === url) process.exit(0);

// Validate it's JSON; if not, forward an empty object so the route 204s harmlessly.
let body = payload;
try { JSON.parse(payload); } catch { body = '{}'; }

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 4000);

fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
  signal: ac.signal,
})
  .catch(() => {})
  .finally(() => { clearTimeout(timer); process.exit(0); });
