# Progressive Scrollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A CLI thread opens fast on mobile (256 KB instead of 4 MB) and can still reach older output by scrolling up, which rebuilds the terminal and restores the reader's position.

**Architecture:** Client asks for a small replay on mobile; a new `GET /api/terminals/:id/scrollback` reports the ring's true size so the client knows more exists; scrolling to the top re-attaches at the next size up (256 KB → 1 MB → 4 MB) and restores the scroll anchor.

**Tech Stack:** TypeScript ESM, React, xterm.js, Express, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-19-progressive-scrollback-design.md`.
- **Desktop behavior must not change**: it keeps the 4 MB initial replay, so its replay is never trimmed and the rebuild path never triggers there.
- Never inject JSON control frames into the terminal websocket — it carries raw PTY bytes and a stray frame corrupts output. Buffer metadata goes over HTTP.
- Live output must not be dropped during a rebuild: new socket opens before the old one closes, and data arriving mid-rebuild is buffered then written.
- The server already repaints trimmed replays (SIGWINCH nudge in `ws/terminal.ts`); do not duplicate or disturb that.
- Core tests from `packages/core`, web tests from `packages/web` (`npx vitest run`), never the repo root.
- The user's REAL daemon runs on this Mac (port 3456) and their mini is remote: no lifecycle commands, no attaching to real threads, isolated daemon (fake HOME, PORT 3999) only where stated.

---

### Task 1: server reports the ring's true size

**Files:**
- Modify: `packages/core/src/pty/manager.ts` (expose the buffer's byte count), `packages/core/src/routes/terminals.ts` (new GET), possibly `packages/core/src/pty/buffer.ts` if no size getter exists
- Test: wherever `routes/terminals` and pty buffer tests live (check colocated `src/**/*.test.ts` vs `tests/` — this repo has both conventions; match the neighbours)

**Interfaces:**
- Produces: `PTYManager.getBufferSize(terminalId: string): number` (0 when unknown) and `GET /api/terminals/:id/scrollback` → `200 { totalBytes: number }`, `404` for an unknown terminal.

- [ ] **Step 1: Failing tests** — buffer/manager: a ring fed N bytes reports N, and reports the capped size once it has wrapped past the 4 MB cap; route: returns the manager's number, 404 on unknown id.
- [ ] **Step 2:** RED → implement (read `pty/buffer.ts` first — it already tracks `totalSize`/`maxSize`; prefer exposing what exists over adding new accounting) → GREEN.
- [ ] **Step 3:** full core suite GREEN, `npx tsc -b` clean.
- [ ] **Step 4: Commit** — `feat(api): report a terminal's scrollback size`

---

### Task 2: client attaches small on mobile and can request more

**Files:**
- Modify: `packages/web/src/api/terminal-socket.ts` (replay constants + an explicit size on connect), `packages/web/src/api/client.ts` (add the scrollback fetch)
- Test: colocated web tests for these modules (create if absent, matching neighbours)

**Interfaces:**
- Produces: exported `INITIAL_REPLAY_MOBILE = 256_000`, `MAX_REPLAY = 4_000_000`, `nextReplayStep(current: number): number` (256 K → 1 M → 4 M, saturating at MAX), and `api.getScrollbackSize(terminalId): Promise<number>`.
- The socket module accepts an explicit `replayBytes` per connect (it already takes an option — keep the existing default for callers that don't pass one, so desktop is untouched).

- [ ] **Step 1: Failing tests** — `nextReplayStep` walks 256 K → 1 M → 4 M and saturates (never exceeds MAX, never shrinks); the connect URL carries the requested size verbatim; `getScrollbackSize` hits the right path and returns the number.
- [ ] **Step 2:** RED → implement → GREEN → full web suite → `npx tsc -b --noEmit` clean.
- [ ] **Step 3: Commit** — `feat(web): replay-size steps and scrollback-size client`

---

### Task 3: TerminalTab — open small on mobile, rebuild on scroll-to-top

**Files:**
- Modify: `packages/web/src/components/tabs/TerminalTab.tsx`
- Test: colocated test for TerminalTab (create if absent; xterm needs mocking — check whether the repo already mocks `@xterm/xterm` anywhere and reuse that approach)

**Interfaces:** Consumes Task 2's constants/helpers and `api.getScrollbackSize`.

Behavior to implement:
1. On mount, connect with `useIsMobile() ? INITIAL_REPLAY_MOBILE : MAX_REPLAY`. Desktop path must be byte-identical to today.
2. After the replay lands, call `api.getScrollbackSize(id)`; if `totalBytes > requested`, older history exists — remember that.
3. When the viewport reaches the top (xterm `onScroll` / `buffer.active.viewportY === 0`) and older history exists and no rebuild is in flight: rebuild at `nextReplayStep(current)`.
4. **Rebuild sequence** (order matters): open the new socket → buffer any live frames arriving meanwhile → once the replay frame lands, record `buffer.active.length` and `viewportY`, `term.reset()`, write the replay, write the buffered live frames, then scroll to `viewportY + (newLength - oldLength)` → close the old socket last.
5. Guard against re-entry (one rebuild at a time) and stop offering more once `current === MAX_REPLAY` or the delivered payload equals `totalBytes`.

- [ ] **Step 1: Failing tests** — mobile mount requests 256 K and desktop requests 4 M; scroll-to-top with more history triggers exactly one rebuild at the next step; a second scroll event during a rebuild does NOT start another; live frames delivered mid-rebuild appear in the terminal after the replay (assert order, not just presence); at MAX no further rebuild is attempted.
- [ ] **Step 2:** RED → implement → GREEN → full web suite → typecheck clean.
- [ ] **Step 3: Commit** — `feat(web): progressive scrollback for CLI threads on mobile`

---

### Task 4: runtime verification (isolated daemon)

**Files:** none committed unless a defect is found.

- [ ] **Step 1:** Build; launch per `.claude/skills/verify/SKILL.md` — fake HOME under the scratchpad, `PORT=3999`, `DISPATCH_WEB_DIST=<worktree>/packages/web/dist`. NEVER port 3456, never the real `~/.dispatch`, never the user's mini.
- [ ] **Step 2:** Create a session and a `shell` terminal; generate a large scrollback deliberately (e.g. send a command that prints ~1 MB, or write repeatedly) so the ring exceeds the small replay size.
- [ ] **Step 3:** `GET /api/terminals/<id>/scrollback` → assert `totalBytes` reflects the real ring size.
- [ ] **Step 4:** Attach over websocket with `replayBytes=200000` → assert the delivered replay frame is trimmed to ~200 KB, NOT the full ring. Then attach with the full size → assert the larger payload. These two numbers are the entire basis of the feature; confirm them against a real daemon, not a mock. (Use the `ws` module via `createRequire` per the verify skill.)
- [ ] **Step 5:** Kill the daemon (`lsof -ti :3999 | xargs kill`). Report evidence per step; on failure report BLOCKED with the daemon log tail rather than fixing code.

---

## Self-Review (performed)

- **Spec coverage:** small initial attach → T2/T3; knowing more exists → T1 + T3 step 2; load-older rebuild with anchor restoration → T3; no-dropped-output ordering → T3 step 4 and its test; trimmed-replay repaint is server-side and untouched.
- **Placeholders:** none — where the plan says "match the neighbours", it names the decision (colocated vs `tests/`) the implementer must check in a real checked-in file.
- **Type consistency:** `INITIAL_REPLAY_MOBILE` / `MAX_REPLAY` / `nextReplayStep` / `getScrollbackSize` / `totalBytes` spelled identically across server route, client, and component.
- **Risk note:** Task 3 is the only genuinely tricky one (async rebuild against a stateful terminal). Its ordering requirements are spelled out as numbered steps precisely because getting them wrong silently drops user output.
