# Dispatch — Progressive Scrollback for CLI Threads

**Date:** 2026-07-19
**Status:** Approved through implementation.

## The bug, and its measured cause

Opening a thread on mobile takes ~15 seconds the first time; afterwards it's
fast. Root-caused by measurement against the live daemon, not inference:

`packages/web/src/api/terminal-socket.ts` requests `replayBytes = 4_000_000`
on every attach, and the PTY scrollback ring caps at exactly 4 MB
(`packages/core/src/pty/buffer.ts`). Any thread that has produced a lot of
output therefore has a FULL ring, and attaching downloads all of it.

Controlled comparison, same thread, same server, seconds apart:

| Requested | Delivered | First byte |
|---|---|---|
| `replayBytes=200000` | 200,000 B | 78 ms |
| `replayBytes=4000000` | 3,999,942 B | 235 ms |

An idle thread (150 KB ring) attaches in 69 ms; the busy thread ships 4 MB.
The server trims correctly when asked — the client simply never asks.

Why it hurts mobile specifically: 4 MB moves in ~160 ms over a LAN-speed
Tailscale link but takes ~10 s on cellular, and xterm.js must then parse and
render 4 MB of ANSI on a phone CPU. Why it's fast afterwards: the component
and socket stay mounted, so the cost is paid once per page session.

## Constraint that shapes the design

xterm.js is **append-only**. There is no API to prepend older scrollback to
an existing buffer. ChatView's reverse-infinite-scroll (already shipped)
works because it renders React nodes it can prepend to; a terminal cannot
do that. Showing older output therefore requires rebuilding the buffer and
restoring the reader's scroll position.

## Design

**1. Attach small.** The initial attach requests `INITIAL_REPLAY_BYTES`
(256 KB) on mobile; desktop keeps 4 MB and is unchanged. The trigger is the
existing `useIsMobile()` hook.

**2. Know whether more exists.** New endpoint
`GET /api/terminals/:id/scrollback` → `{ totalBytes: number }`, reading the
ring's current size. The client compares it against how much it received.
Deliberately NOT a control message on the websocket: that stream carries
raw PTY bytes, and injecting JSON risks corrupting terminal output.

**3. Load older on demand.** When the reader scrolls to the top of the
terminal and more history exists, the client re-attaches requesting the
next size up (256 KB → 1 MB → 4 MB cap), rebuilds the buffer, and restores
the scroll anchor so the line the reader was looking at stays put:
record `buffer.active.length` and `viewportY` before, and after the rebuild
scroll to `viewportY + (newLength - oldLength)`.

**4. Don't lose live output during a rebuild.** Open the new socket BEFORE
tearing down the old one, buffer any live data that arrives mid-rebuild,
and write it after the replay lands. A thread actively producing output
must not drop bytes because the reader scrolled up.

**5. Trimmed replays already repaint.** The server sends a repaint nudge
(SIGWINCH) when a replay is incomplete, so a TUI redraws its screen rather
than showing a half-painted one. This path exists today and is what makes
asking for less safe.

## Non-goals

- Changing desktop behavior (4 MB stays; no rebuild ever triggers there
  because its replay is never trimmed).
- Paging the Pretty/ChatView transport — it already has this.
- Persisting scrollback beyond the in-memory ring.
- Changing the 4 MB server-side ring cap.

## Testing

- **Client unit:** initial replay is 256 KB on mobile and 4 MB on desktop;
  `loadOlder` requests the next size up and stops at the 4 MB cap; scroll
  anchor restoration maths (`viewportY + delta`); live data arriving during
  a rebuild is buffered and written after, not dropped.
- **Server unit:** `GET /api/terminals/:id/scrollback` returns the ring's
  byte count; 404 for an unknown terminal.
- **Runtime (isolated daemon):** attach with a small `replayBytes` against a
  terminal with a larger ring, assert the delivered payload is trimmed to
  the request and that `scrollback` reports the true larger total — the two
  numbers that drive the whole feature.
