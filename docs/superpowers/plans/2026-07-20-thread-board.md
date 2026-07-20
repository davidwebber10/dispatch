# Phase 2 — The thread board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cross-project board that answers one question per thread — *will this move without me?*

**Architecture:** A pure `boardColumn(terminal, liveStatus)` mapper feeds a `useBoardData()` hook that folds every project's terminals into four columns. Acknowledgement and manual overrides persist on the terminal row; an override clears itself when the thread shows real activity. Desktop renders four columns full-bleed, bypassing `Workspace` entirely; mobile renders the same model as stacked collapsible sections behind a settings mode picker.

**Tech Stack:** TypeScript, React 18, Zustand, Vitest + @testing-library (`packages/web`); Express + better-sqlite3 (`packages/core`).

**Spec:** `docs/superpowers/specs/2026-07-20-thread-board-design.md` — approved, do not re-litigate.
**Mockups (authoritative for layout):** `.superpowers/brainstorm/65628-1784514698/content/columns-v7.html` (desktop) and `mobile.html` (phone). Follow them literally.

## Global Constraints

- `packages/web` uses inline `style={{}}` plus CSS custom properties. **No Tailwind.**
- **The board MUST use the app-global `var(--color-*)` tokens, never the `--tp`/`--elev`/`--acc` set.** Those are scoped to `:where(.overseer-root)` (`components/overseer/tokens.css`) and resolve to *nothing* outside `OverseerView`/`OverseerMobile` — silently, with no build error.
- **When the board renders `WorkerLightbox`, it must wrap it in a `.overseer-root` div**, because the lightbox and its children (`AgentDetailHeader`, `atoms.tsx`) are built on those scoped vars.
- `packages/core` is ESM: relative imports carry `.js`, including tests.
- Column identity and order are fixed: **Needs Help · Complete · Working · Resting** — ordered by whose move it is, not lifecycle.
- Colors, from the mockups: needs-help `#e8b04b`, complete `#5A8DD6`, working `var(--color-accent)`, resting muted/`var(--color-border)`.
- Tests: `pnpm -C packages/web test`, `pnpm -C packages/core test`. Build: `pnpm build`.
- Commit after every task.

---

## What already exists (do not rebuild)

- **Live cross-project status already flows.** `createEventsBroadcaster` (`core/src/ws/events.ts`) sends every event to every client, and `useThreadStatus.byTerminal` is keyed by terminal id with **no project scope**. Nothing needs changing for live updates.
- **The cross-project load pattern is in production.** `components/mobile/PinnedThreadsView.tsx:22-36` does `Promise.all(projects.map(p => useTabs.getState().loadTabs(p.id)))` then reads the union of `byProject`. Copy this shape.
- **`findTerminal(byProject, id)`** (`stores/tabs.ts:39`) already scans every project.
- **`config.lastOutcome`** (`{summary, needsHelp, inferred, at}`) already reaches the client on every `Terminal`, because `Terminal.config` is `Record<string, unknown>`. The board is its first consumer.
- **`WorkerLightbox`** (`components/overseer/components/WorkerLightbox.tsx`) takes **no props** — opened by `useOverseer.getState().drillInto(id)`, closed by `closeWorkerLightbox()`. There is a second, DEAD `components/overseer/WorkerLightbox.tsx` — do not import that one.

---

## Task 1 (core): board state — acknowledgement and manual override

**Files:**
- Modify: `packages/core/src/sessions/service.ts`
- Modify: `packages/core/src/routes/terminals.ts`
- Modify: `packages/core/src/status/service.ts`
- Test: `packages/core/src/routes/terminals.test.ts`, `packages/core/tests/status/service.test.ts`

**Interfaces produced:**
- `SessionService.setBoardState(terminalId, patch: { acknowledged?: boolean; override?: 'needs_help' | 'complete' | 'resting' | null }): boolean`
- `POST /api/terminals/:terminalId/board`
- Persisted on the terminal's config as `boardState: { acknowledgedAt?: string; override?: string | null }`

- [ ] **Step 1: Write the failing tests**

```ts
describe('POST /api/terminals/:id/board', () => {
  it('acknowledges a thread', async () => {
    const setBoardState = vi.fn().mockReturnValue(true);
    const res = await request(app({ setBoardState })).post('/api/terminals/t1/board').send({ acknowledged: true });
    expect(res.status).toBe(204);
    expect(setBoardState).toHaveBeenCalledWith('t1', { acknowledged: true });
  });

  it('sets a manual override', async () => {
    const setBoardState = vi.fn().mockReturnValue(true);
    const res = await request(app({ setBoardState })).post('/api/terminals/t1/board').send({ override: 'complete' });
    expect(res.status).toBe(204);
    expect(setBoardState).toHaveBeenCalledWith('t1', { override: 'complete' });
  });

  it('rejects an override of "working" — that is an observed fact, not a judgement', async () => {
    const res = await request(app({ setBoardState: vi.fn() })).post('/api/terminals/t1/board').send({ override: 'working' });
    expect(res.status).toBe(400);
  });

  it('404s an unknown terminal', async () => {
    const res = await request(app({ setBoardState: vi.fn().mockReturnValue(false) })).post('/api/terminals/t1/board').send({ acknowledged: true });
    expect(res.status).toBe(404);
  });
});
```

And in the status-service tests — the override must not outlive real activity:

```ts
it('clears a manual override when the thread shows real activity', () => {
  // seed a terminal whose config carries boardState.override = 'complete'
  svc.markWorking('t1');
  const cfg = JSON.parse(terminalsDb.getById(db, 't1')!.config || '{}');
  expect(cfg.boardState?.override ?? null).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm -C packages/core test -- terminals` and `-- status`
Expected: FAIL — route 404s, override survives.

- [ ] **Step 3: Add the service method**

In `packages/core/src/sessions/service.ts`, beside `noteTurnOutcome`:

```ts
  /**
   * Board-only state: whether the human has acknowledged a finished thread, and any manual
   * correction of its derived column. Both live on the terminal row because the board is a
   * projection — the thread itself has no opinion about either.
   *
   * `override` deliberately cannot be 'working': the other three are judgements the human is
   * entitled to make, but working is an OBSERVED FACT — asserting it would not start anything.
   * Route-level validation enforces that; this method trusts its caller.
   */
  setBoardState(terminalId: string, patch: { acknowledged?: boolean; override?: string | null }): boolean {
    const terminal = terminalsDb.getById(this.db, terminalId);
    if (!terminal) return false;
    let cfg: Record<string, any> = {};
    try { cfg = JSON.parse(terminal.config || '{}'); } catch { /* default {} */ }
    const board = { ...(cfg.boardState ?? {}) };
    if (patch.acknowledged !== undefined) {
      board.acknowledgedAt = patch.acknowledged ? new Date().toISOString() : undefined;
    }
    if (patch.override !== undefined) board.override = patch.override;
    cfg.boardState = board;
    try { terminalsDb.updateConfig(this.db, terminalId, cfg); } catch { return false; }
    return true;
  }
```

- [ ] **Step 4: Clear the override on real activity**

In `packages/core/src/status/service.ts`'s `apply()`, alongside the existing config stamping that `markScheduled` does. An override corrects a stale reading; once there IS a fresh reading, the correction has done its job.

```ts
    // A manual override is a correction to a stale derived status. Real activity supersedes
    // it — otherwise a thread the human filed away could never tell them it came back to
    // life, which is the same class of bug the board exists to remove.
    if (status === 'working' || status === 'needs_input') {
      try {
        const cfg = JSON.parse(terminalsDb.getById(this.db, terminalId)?.config || '{}');
        if (cfg.boardState?.override) {
          cfg.boardState = { ...cfg.boardState, override: null };
          terminalsDb.updateConfig(this.db, terminalId, cfg);
        }
      } catch { /* best effort — status must never fail on board bookkeeping */ }
    }
```

- [ ] **Step 5: Add the route**

In `packages/core/src/routes/terminals.ts`, near the other terminal-scoped POSTs:

```ts
  // POST /api/terminals/:terminalId/board — board-only state: acknowledge a finished thread,
  // or manually correct its derived column. 'working' is rejected: the other three are
  // judgements the human may make, but working is an observed fact.
  router.post('/terminals/:terminalId/board', (req, res) => {
    const { acknowledged, override } = req.body ?? {};
    const patch: { acknowledged?: boolean; override?: string | null } = {};
    if (acknowledged !== undefined) {
      if (typeof acknowledged !== 'boolean') return res.status(400).json({ error: 'acknowledged must be a boolean' });
      patch.acknowledged = acknowledged;
    }
    if (override !== undefined) {
      if (override !== null && override !== 'needs_help' && override !== 'complete' && override !== 'resting') {
        return res.status(400).json({ error: "override must be null, 'needs_help', 'complete' or 'resting'" });
      }
      patch.override = override;
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing to set' });
    try {
      const ok = sessionService.setBoardState(req.params.terminalId, patch);
      if (!ok) return res.status(404).json({ error: 'Terminal not found' });
      res.status(204).end();
    } catch (e: any) { res.status(400).json({ error: e?.message ?? String(e) }); }
  });
```

- [ ] **Step 6: Run tests, then commit**

Run: `pnpm -C packages/core test` (full suite green; the suite is intermittently flaky — re-run before believing a red).

```bash
git add packages/core/src/sessions/service.ts packages/core/src/routes/terminals.ts packages/core/src/status/service.ts packages/core/src/routes/terminals.test.ts packages/core/tests/status/service.test.ts
git commit -m "feat(core): board state — acknowledgement and manual override

An override corrects a stale derived status, so real activity clears it:
otherwise a thread the human filed away could never tell them it came back
to life. 'working' is not an offerable override — it is an observed fact."
```

---

## Task 2 (web): the column mapper and cross-project data hook

**Files:**
- Create: `packages/web/src/components/board/boardColumn.ts`
- Create: `packages/web/src/components/board/boardColumn.test.ts`
- Create: `packages/web/src/components/board/useBoardData.ts`
- Modify: `packages/web/src/api/types.ts` — widen `TerminalStatus`, type `lastOutcome`/`boardState`
- Modify: `packages/web/src/api/client.ts` — `setBoardState`

**Interfaces produced:**
```ts
export type BoardColumn = 'needs_help' | 'complete' | 'working' | 'resting';
export interface BoardCardModel {
  terminalId: string; projectId: string; projectName: string;
  label: string; column: BoardColumn;
  detail: string;              // the line under the title
  inferred: boolean;           // an inferred ask renders dimmer with a ~ marker
  pending: boolean;            // Working sub-tier: queued/scheduled/blocked rather than live
  overridden: boolean;
}
export function boardColumn(t: Terminal, s?: LiveStatus): BoardColumn
export function useBoardData(projectFilter: string | null): { columns: Record<BoardColumn, BoardCardModel[]>; loading: boolean; projects: {id:string;name:string}[] }
```

- [ ] **Step 1: Write the failing test for the pure mapper**

```ts
import { describe, it, expect } from 'vitest';
import { boardColumn } from './boardColumn';

const t = (config: any = {}, status = 'waiting') => ({ id: 'x', status, config, archivedAt: null } as any);

describe('boardColumn', () => {
  it('needs_input lands in needs help', () => {
    expect(boardColumn(t({}, 'needs_input'))).toBe('needs_help');
  });

  it('a live turn is working', () => {
    expect(boardColumn(t({}, 'working'))).toBe('working');
  });

  it('queued and scheduled are working — they proceed without you', () => {
    expect(boardColumn(t({}, 'queued'))).toBe('working');
    expect(boardColumn(t({}, 'scheduled'))).toBe('working');
  });

  it('a finished, unacknowledged turn is complete', () => {
    expect(boardColumn(t({ lastOutcome: { summary: 'merged', needsHelp: false, inferred: false } }, 'waiting'))).toBe('complete');
  });

  it('acknowledging a finished turn moves it to resting', () => {
    expect(boardColumn(t({ lastOutcome: { summary: 'merged' }, boardState: { acknowledgedAt: '2026-07-20T00:00:00Z' } }, 'waiting'))).toBe('resting');
  });

  it('a thread that never ran a turn is resting, not complete', () => {
    expect(boardColumn(t({}, 'waiting'))).toBe('resting');
  });

  it('an archived thread is resting', () => {
    expect(boardColumn({ ...t(), archivedAt: '2026-01-01' } as any)).toBe('resting');
  });

  it('a manual override wins over the derived column', () => {
    expect(boardColumn(t({ boardState: { override: 'needs_help' } }, 'waiting'))).toBe('needs_help');
  });

  it('live status beats the persisted row', () => {
    expect(boardColumn(t({}, 'waiting'), { status: 'working', threadStatus: 'working' } as any)).toBe('working');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm -C packages/web test -- boardColumn`

- [ ] **Step 3: Implement the mapper**

The decision order matters and mirrors the spec's decision tree. Write it as an explicit early-return chain with the reasoning in comments — override, then archived, then live-status, then outcome+acknowledgement, then default resting.

- [ ] **Step 4: Widen the types**

In `packages/web/src/api/types.ts`, `TerminalStatus` is currently `'working' | 'waiting' | 'needs_input' | 'error'` but the backend genuinely persists and broadcasts `'scheduled'` and `'queued'` too. Add both. Also add typed shapes for the two config blobs the board consumes (`lastOutcome`, `boardState`) as an exported interface — `Terminal.config` stays `Record<string, unknown>`, but the board should parse through a typed helper rather than casting inline at each use.

- [ ] **Step 5: Implement `useBoardData`**

Follow `PinnedThreadsView.tsx:22-36` exactly for the cross-project load — `Promise.all(projects.map(p => useTabs.getState().loadTabs(p.id)))` on mount with an `alive` guard — then fold `byProject` × `useThreadStatus().byTerminal` through `boardColumn`. Memoize on `[byProject, byTerminal, projectFilter]`. Do NOT try to reuse `useRenderVals()`; it is hard-scoped to the active project at `overseer/store.ts:642`.

- [ ] **Step 6: Add the client method**

```ts
  setBoardState: (terminalId: string, patch: { acknowledged?: boolean; override?: string | null }) =>
    req<void>(`/api/terminals/${terminalId}/board`, { method: 'POST', body: JSON.stringify(patch) }),
```

- [ ] **Step 7: Tests green, build clean, commit**

---

## Task 3 (web): `BoardCard`

**Files:**
- Create: `packages/web/src/components/board/BoardCard.tsx`
- Create: `packages/web/src/components/board/BoardCard.test.tsx`

Renders one `BoardCardModel`. Match `columns-v7.html` exactly: project tag (10px, ~0.5 opacity), thread label (600 weight), a detail line, and column-appropriate treatment.

- Needs Help: amber border `rgba(232,176,75,.55)`, tinted background, the question in italics, an **Answer** action.
- Inferred ask: same column, dimmer border `rgba(232,176,75,.3)`, a `~` marker after the label, **Open** plus a dismiss `✕`.
- Complete: blue `rgba(90,141,214,.5)`, the outcome line, a `☐` check-off control.
- Working live: green border, `● running · 4m · opus`.
- Working pending: **dashed** border, dimmed, `◌ queued` / `◌ wakes in 20m` / `◌ behind "X"`.
- Resting: quietest — thin border, ~0.55 opacity, outcome line if present else `new — no work yet`.

Props are pure data plus callbacks (`onOpen`, `onAcknowledge`, `onDismissInferred`, `onOverride`). No store reads, no API calls — the card is presentational so it can be tested without a daemon.

Tests: each column renders its distinguishing affordance; an inferred card renders the marker and dismiss; a pending card renders dashed; each callback fires from its own control **and only its own** (render fresh per case — clicking all then asserting one call each passes even if handlers are swapped).

---

## Task 4 (web): desktop board

**Files:**
- Create: `packages/web/src/components/board/BoardView.tsx`
- Create: `packages/web/src/components/board/BoardView.test.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/stores/ui.ts`

Four columns side by side, per `columns-v7.html`. Header carries the mode switch and project filter chips (`All projects` default). Resting is deliberately the narrowest and quietest — it will hold the large majority of threads and is never meant to be read.

**Mounting is the subtle part.** `Workspace` requires `sidebar`/`main`/`inspector` and has no full-bleed mode; the existing `showAgent` precedent swaps only `main`. So board mode must **bypass `Workspace` entirely** — branch above it in `App.tsx` and render `<BoardView/>` directly inside `AppShell`. Do not add a "hide everything" prop to `Workspace`.

`stores/ui.ts` already declares `view: 'workspace' | 'agents'` with a `setView` — and **nothing reads it** (dead code). Repurpose it to `'workspace' | 'board'` rather than adding a parallel flag. Persist it like `leftCollapsed` so the choice survives a reload.

Working column renders its two tiers with the `WAITING — RESUMES ON ITS OWN` divider between them, per the mockup.

Tests: four columns render with correct counts; the filter chip narrows to one project; an empty column renders its header and a zero count rather than vanishing; the Working column separates live from pending.

---

## Task 5 (web): mobile board

**Files:**
- Create: `packages/web/src/components/board/BoardMobile.tsx`
- Create: `packages/web/src/components/board/BoardMobile.test.tsx`
- Modify: `packages/web/src/components/mobile/MobileApp.tsx`

Stacked collapsible sections on one vertical scroll, per `mobile.html`: **Needs Help and Complete expanded** (the two that want you), **Working and Resting collapsed** to a header and count. Every count visible without a gesture — that is the whole point, and it is why swipeable columns were rejected.

Reuses `BoardCard` unchanged.

Tests: needs-help and complete sections start expanded; working and resting start collapsed but show their counts; tapping a collapsed header expands it.

---

## Task 6 (web): the mobile view-mode picker

**Files:**
- Modify: `packages/web/src/stores/settings.ts`
- Modify: `packages/web/src/components/settings/GeneralSection.tsx`
- Create: `packages/web/src/components/settings/ViewModeMiniature.tsx`

Add `mobileViewMode: 'threads' | 'board'` (default `'threads'`), mirroring `density`/`coordinatorName`: one field via `load('dispatch:mobileViewMode', 'threads')`, one setter that `save`s then `set`s.

The picker goes in `GeneralSection`'s Appearance block (there is no top-level Appearance section — confirm by reading the file). **Each mode renders as a 52px miniature of itself, not a labelled radio**: Threads as a flat grey list, Board as amber/blue/green/grey bands. Recognition rather than a symbol to learn — and it keeps the two modes honest, since thumbnails that look alike would mean modes that aren't different enough to both exist.

Tests: the setting persists; selecting Board switches the mobile root; the default is Threads.

---

## Task 7 (web): card actions

**Files:**
- Modify: `packages/web/src/components/board/BoardView.tsx`, `BoardMobile.tsx`
- Create: `packages/web/src/components/board/MoveToMenu.tsx`

- **Click a card → the thread opens OVER the board.** Call `useOverseer.getState().drillInto(terminalId)` and render `<WorkerLightbox/>`. **It must be wrapped in a `.overseer-root` div** or it renders with unset colors and no error. Opening also auto-acknowledges (`setBoardState({acknowledged:true})`) — you looked, that is the acknowledgement.
- **Check-off** on a Complete card → `setBoardState({acknowledged:true})`.
- **Clear all** on the Complete header → acknowledge every card in that column.
- **Move to** (⋯ desktop, long-press mobile) → three targets only: Needs Help, Complete, Resting. **Never Working.**
- **Dismiss `✕`** on an inferred ask → `setBoardState({override:'complete'})` — it had in fact finished.

Tests: each action calls the right API with the right payload; the Move-to menu offers exactly three targets and never Working; opening a card acknowledges it.

---

## Task 8: visual verification (MANDATORY — not optional)

Drive the built app in a real browser with playwright against a live daemon. Screenshot **desktop (1440×900)** and **mobile (390×844)** widths. Check against `columns-v7.html` and `mobile.html`:

- Do the four columns read in the right order, with Needs Help first?
- Is Resting visibly the quietest and narrowest?
- Do the Working tiers actually look different (solid vs dashed)?
- Does an inferred ask read as subordinate to a real one?
- On mobile, are all four counts visible without scrolling or gestures?
- Any console errors? Any element rendering with unset colors (the `.overseer-root` trap)?

Attach the screenshots and findings to the handoff. **If it looks wrong, fix it or flag it loudly** — the accepted risk on this build was "no human ever looked at it", and this task is the mitigation.

---

## Verification before finishing

- [ ] `pnpm -C packages/web test` — green
- [ ] `pnpm -C packages/core test` — green
- [ ] `pnpm build` — clean
- [ ] Task 8's screenshots reviewed and attached
- [ ] Known gap recorded: the spec makes real declared-vs-inferred numbers a precondition for this phase, and they do not exist yet — Phase 1 shipped hours ago. The board's Needs Help column is therefore built on an unverified heuristic. Surface this in the handoff.
