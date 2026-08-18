#!/usr/bin/env node
// Grok hook helper. Registered per-spawn from a generated plugin's hooks/hooks.json:
//   { "type": "command", "command": "node <this file> <events-url>" }
//
// Grok's hooks use Claude Code's schema, and a `command` hook receives the event JSON on
// STDIN. We forward it verbatim to the events route, which normalizes it into status and
// captures the session id — the same route Claude's hooks post to directly.
//
// `command` rather than `http` on purpose: Grok documents only `type = "command"`, so a
// helper works whichever hook transports a given build supports.
//
// Best-effort and silent: a failed hook must never disrupt the agent.

const url = process.argv[2];
if (!url) process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });

process.stdin.on('end', () => {
  // Forward an empty object rather than junk if the payload is not JSON, so the route
  // 204s harmlessly instead of erroring.
  let body = raw.trim() || '{}';
  try { JSON.parse(body); } catch { body = '{}'; }

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
});

// A hook invoked with no stdin at all must still exit cleanly.
process.stdin.on('error', () => process.exit(0));
