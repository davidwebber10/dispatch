# Control Plane Per-Tab Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Control Plane (overseer) view from ever rendering another project's coordinator transcript — the cross-tab "bleed" and the "new tab shows the last active session's transcript on create" flash.

**Architecture:** The overseer store (`useOverseer`) is a single global singleton holding exactly one coordinator conversation (`coordinatorProject` / `coordinatorId` / `coordinatorStream` / …). Only the active tab's `<OverseerView>` is mounted at a time (`App.tsx:130`, `key={activeTerminalId}`), but on a project switch the store still holds the *previous* project's data until an **async** `ensureForProject` swap lands — so the freshly-mounted view paints the stale project's transcript first. There is exactly one Control Plane tab per project (`dispatch:<sessionId>`), and `useProjects.activeId` always tracks the active tab's project (both are set together in `useTabs.openTab`), so `activeId` uniquely identifies the mounted Control Plane's project. The fix: **gate every coordinator read on `coordinatorProject === activeId`** — when they differ, the store's coordinator fields belong to another project and are treated as empty/loading, never rendered. The existing `ready` spinner in `ConversationStream` (reset on `coordinatorId` change) already covers the resulting load window, so the swap reads as a clean spinner, not a bleed.

**Tech Stack:** React 18 + Zustand + Vite + Vitest + @testing-library/react. All files in `packages/web`.

## Global Constraints

- Package manager: `pnpm`. Run web tests from repo root with `pnpm --filter dispatch-web test` or inside `packages/web` with `pnpm test` (both run `vitest run`).
- Type check / build: `pnpm --filter dispatch-web build` (`tsc -b && vite build`).
- Do NOT introduce a second "current project" identity. Everything in the overseer already derives from `useProjects.activeId` (missions, needs, archived outcomes); the coordinator stream must use the SAME identity so they can never drift.
- The Control Plane label the user sees is "Control Plane" (from `tabLabel`/`useDispatchName`); don't rename anything.
- No behavior change when `coordinatorProject === activeId` (the normal, matched case) — the gate must be a pure pass-through there.

---

### Task 1: Pure gating helpers in the overseer store

Add two pure functions that decide whether the store's loaded coordinator belongs to the project currently being viewed, and derive the view's stream/busy/hasCoordinator accordingly. Pure + exported so they're unit-testable without rendering the hook.

**Files:**
- Modify: `packages/web/src/components/overseer/store.ts` (add exports near the top, after the `EMPTY_IMAGES` constant at line 34; wire into `useRenderVals` at lines 589-649)
- Modify: `packages/web/src/components/overseer/types.ts` (add `projectMatches` to `RenderVals`, after `overviewOpen` at line 218)
- Test: `packages/web/src/components/overseer/store.test.ts` (append a new `describe` block)

**Interfaces:**
- Produces: `coordinatorMatchesView(coordinatorProject: string | null, activeId: string | null): boolean`
- Produces: `viewCoordinatorFields(args: { coordinatorProject: string | null; activeId: string | null; coordinatorStream: StreamMessage[]; coordinatorBusy: boolean; coordinatorId: string | null }): { stream: StreamMessage[]; busy: boolean; hasCoordinator: boolean; projectMatches: boolean }`
- Produces: `RenderVals.projectMatches: boolean` (consumed by Task 2's `ConversationStream`)

- [ ] **Step 1: Write the failing test**

Append to `packages/web/src/components/overseer/store.test.ts`:

```ts
import { coordinatorMatchesView, viewCoordinatorFields } from './store';
import type { StreamMessage } from './types';

const sm = (key: string): StreamMessage =>
  ({ kind: 'text', who: 'overseer', text: key, time: '', key, isUser: false, isOverseer: true, isNote: false } as unknown as StreamMessage);

describe('coordinatorMatchesView — the loaded coordinator belongs to the viewed project', () => {
  it('true only when both ids are set and equal', () => {
    expect(coordinatorMatchesView('proj-a', 'proj-a')).toBe(true);
    expect(coordinatorMatchesView('proj-a', 'proj-b')).toBe(false);
    expect(coordinatorMatchesView(null, 'proj-a')).toBe(false);
    expect(coordinatorMatchesView('proj-a', null)).toBe(false);
    expect(coordinatorMatchesView(null, null)).toBe(false);
  });
});

describe('viewCoordinatorFields — a stale-project coordinator is never surfaced', () => {
  const stream = [sm('a1'), sm('a2')];

  it('passes the coordinator fields through when the project matches', () => {
    const out = viewCoordinatorFields({ coordinatorProject: 'proj-a', activeId: 'proj-a', coordinatorStream: stream, coordinatorBusy: true, coordinatorId: 'coord-a' });
    expect(out.projectMatches).toBe(true);
    expect(out.stream).toBe(stream);
    expect(out.busy).toBe(true);
    expect(out.hasCoordinator).toBe(true);
  });

  it('blanks the stream/busy/hasCoordinator when the store holds ANOTHER project', () => {
    const out = viewCoordinatorFields({ coordinatorProject: 'proj-a', activeId: 'proj-b', coordinatorStream: stream, coordinatorBusy: true, coordinatorId: 'coord-a' });
    expect(out.projectMatches).toBe(false);
    expect(out.stream).toEqual([]);
    expect(out.busy).toBe(false);
    expect(out.hasCoordinator).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && pnpm vitest run src/components/overseer/store.test.ts`
Expected: FAIL — `coordinatorMatchesView is not a function` / `viewCoordinatorFields is not a function`.

- [ ] **Step 3: Add the helpers**

In `packages/web/src/components/overseer/store.ts`, immediately after the `EMPTY_IMAGES` constant (line 34) and its comment block, add:

```ts
// A stable empty-stream reference so viewCoordinatorFields returns the SAME array
// on every mismatched read — a fresh `[]` literal would fail Zustand/useMemo Object.is
// checks and churn re-renders while another project's swap is in flight.
const EMPTY_STREAM: StreamMessage[] = [];

/**
 * True only when the store's loaded coordinator belongs to the project the view is
 * currently showing. When false, the coordinator fields (`coordinatorStream`/`coordinatorId`/
 * `coordinatorBusy`/pending/paging) still hold ANOTHER project's data — the async
 * ensureForProject swap on a tab switch hasn't landed yet — and MUST NOT be rendered,
 * or one Control Plane tab shows a different project's transcript (the cross-tab bleed).
 * `activeId` uniquely identifies the mounted Control Plane's project (one dispatch tab per
 * project; useTabs.openTab sets activeTabId + activeId together).
 */
export function coordinatorMatchesView(coordinatorProject: string | null, activeId: string | null): boolean {
  return !!activeId && coordinatorProject === activeId;
}

/** Project-gated projection of the coordinator fields for the current view: pass-through
 *  when the loaded coordinator matches the viewed project, blanked otherwise. */
export function viewCoordinatorFields(args: {
  coordinatorProject: string | null;
  activeId: string | null;
  coordinatorStream: StreamMessage[];
  coordinatorBusy: boolean;
  coordinatorId: string | null;
}): { stream: StreamMessage[]; busy: boolean; hasCoordinator: boolean; projectMatches: boolean } {
  const projectMatches = coordinatorMatchesView(args.coordinatorProject, args.activeId);
  return {
    stream: projectMatches ? args.coordinatorStream : EMPTY_STREAM,
    busy: projectMatches ? args.coordinatorBusy : false,
    hasCoordinator: projectMatches && !!args.coordinatorId,
    projectMatches,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && pnpm vitest run src/components/overseer/store.test.ts`
Expected: PASS (all describe blocks, including the pre-existing composer-image tests).

- [ ] **Step 5: Wire the helper into `useRenderVals` and add `projectMatches` to `RenderVals`**

In `packages/web/src/components/overseer/types.ts`, add a field to the `RenderVals` interface (after `overviewOpen: boolean;` at line 218):

```ts
  /** True when the store's loaded coordinator belongs to the project currently shown.
   *  Consumers gate direct coordinator reads (pending, older-history paging) on this so a
   *  freshly-switched tab never acts on the previous project's coordinator. */
  projectMatches: boolean;
```

In `packages/web/src/components/overseer/store.ts`, add `coordinatorProject` to the `useRenderVals` selector (the `useShallow` block at lines 590-600) so it reads:

```ts
  const { coordinatorId, coordinatorProject, coordinatorStream, coordinatorBusy, sendError, resolved, pendingByTerminal, archivedByProject } = useOverseer(
    useShallow((s) => ({
      coordinatorId: s.coordinatorId,
      coordinatorProject: s.coordinatorProject,
      coordinatorStream: s.coordinatorStream,
      coordinatorBusy: s.coordinatorBusy,
      sendError: s.sendError,
      resolved: s.resolved,
      pendingByTerminal: s.pendingByTerminal,
      archivedByProject: s.archivedByProject,
    })),
  );
```

Then inside the `return useMemo(() => { … }, [...])` body (starting line 605), replace the coordinator-derived section. The current code reads:

```ts
    const hasNeeds = needs.length > 0;
    const noMissions = missions.length === 0;
    const hasCoordinator = !!coordinatorId;
    const emptyMode = !hasCoordinator || (noMissions && coordinatorStream.length === 0);

    // First-run / empty conversation → the Overseer greeting.
    const base: StreamMessage[] = coordinatorStream.length
      ? coordinatorStream
      : [m('overseer', 'Control Plane', CANNED.emptyGreeting, '', 'greeting')];
```

Replace those lines with:

```ts
    // Project-gate the coordinator fields: if the store still holds ANOTHER project's
    // coordinator (the async ensureForProject swap on a tab switch hasn't landed), treat
    // it as empty so this tab never paints the previous project's transcript.
    const { stream: gatedStream, busy: gatedBusy, hasCoordinator, projectMatches } = viewCoordinatorFields({
      coordinatorProject,
      activeId,
      coordinatorStream,
      coordinatorBusy,
      coordinatorId,
    });

    const hasNeeds = needs.length > 0;
    const noMissions = missions.length === 0;
    const emptyMode = !hasCoordinator || (noMissions && gatedStream.length === 0);

    // First-run / empty conversation → the Overseer greeting.
    const base: StreamMessage[] = gatedStream.length
      ? gatedStream
      : [m('overseer', 'Control Plane', CANNED.emptyGreeting, '', 'greeting')];
```

Then in the same `return { … }` object (lines 635-647), change `busy: coordinatorBusy,` to `busy: gatedBusy,` and add `projectMatches,` to the returned object. Finally, add `coordinatorProject` to the `useMemo` dependency array at line 648 (insert after `coordinatorId,`):

```ts
  }, [coordinatorId, coordinatorProject, coordinatorStream, coordinatorBusy, sendError, resolved, pendingByTerminal, archivedByProject, activeId, byProject, byTerminal]);
```

- [ ] **Step 6: Type-check**

Run: `cd packages/web && pnpm exec tsc -b`
Expected: no errors (a clean exit). If `tsc` reports `projectMatches` missing on a `RenderVals` literal elsewhere, that's the mock store in a test — grep `packages/web/src` for object literals typed as `RenderVals` and add `projectMatches: true` to each.

- [ ] **Step 7: Run the overseer test suite**

Run: `cd packages/web && pnpm vitest run src/components/overseer`
Expected: PASS (store.test.ts, live.test.ts, and the component tests under `components/`).

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/overseer/store.ts packages/web/src/components/overseer/types.ts packages/web/src/components/overseer/store.test.ts
git commit -m "fix(web): project-gate the Control Plane coordinator stream so a tab never renders another project's transcript

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Gate `ConversationStream`'s direct coordinator reads on `projectMatches`

`ConversationStream` reads `coordinatorPending` / `coordinatorHasMore` / `coordinatorLoadingOlder` / `coordinatorLoadOlder` directly from `useOverseer` (Stream.tsx:537-542) — bypassing the `useRenderVals` gate from Task 1. During a tab swap these still point at the previous project's coordinator, so `BootstrapOlderPages` can fire `loadOlder()` against it and a stale pending question can flash. Gate all of them on `projectMatches`.

**Files:**
- Modify: `packages/web/src/components/overseer/components/Stream.tsx:536-602`
- Test: manual (Task 3) — component-rendering a scroll/bootstrap race is not worth a brittle unit test; the pure gate is already covered in Task 1.

**Interfaces:**
- Consumes: `useRenderVals().projectMatches` (from Task 1).

- [ ] **Step 1: Consume `projectMatches` and gate paging + pending**

In `packages/web/src/components/overseer/components/Stream.tsx`, change the `ConversationStream` destructure at line 536 from:

```ts
  const { stream, busy } = useRenderVals();
```

to:

```ts
  const { stream, busy, projectMatches } = useRenderVals();
```

Then gate the paging inputs. The current `onViewportScroll` (lines 547-549) and the `BootstrapOlderPages`/pending render use the raw store values. Update them so paging and pending only act when the loaded coordinator matches this view:

Change `onViewportScroll` (lines 547-549) to:

```ts
  function onViewportScroll(e: React.UIEvent<HTMLDivElement>) {
    if (e.currentTarget.scrollTop < 120 && projectMatches && coordinatorHasMore && !coordinatorLoadingOlder) coordinatorLoadOlder();
  }
```

Change the `BootstrapOlderPages` element (line 602) to gate `hasMore`:

```tsx
          <BootstrapOlderPages hasMore={projectMatches && coordinatorHasMore} loadingOlder={coordinatorLoadingOlder} loadOlder={coordinatorLoadOlder} />
```

Change the inline pending-question render condition (line 582) so a stale project's pending never shows:

```tsx
              {projectMatches && coordinatorPending?.questions && coordinatorPending.questions.length > 0 && (
```

And update `hasPendingQuestion` (line 563) so the paint-gate override also respects the project match:

```ts
  const hasPendingQuestion = projectMatches && !!coordinatorPending?.questions?.length;
```

- [ ] **Step 2: Type-check**

Run: `cd packages/web && pnpm exec tsc -b`
Expected: clean exit, no errors.

- [ ] **Step 3: Run the Stream component tests**

Run: `cd packages/web && pnpm vitest run src/components/overseer/components/Stream.test.tsx`
Expected: PASS (existing assertions still hold — the matched-project path is unchanged, since these tests set up a single coordinator whose project matches).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/overseer/components/Stream.tsx
git commit -m "fix(web): gate Control Plane older-history paging + pending on the matched project

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Live verification of the bleed fix

Build the daemon, restart it, and reproduce the original scenario in a browser to confirm a freshly-opened / switched Control Plane tab never shows another project's transcript.

**Files:** none (verification only).

- [ ] **Step 1: Build the web client + restart the daemon**

Run:
```bash
cd /Users/jdetamore/Developer/Projects/dispatch
pnpm --filter dispatch-web build && ./bin/dispatch restart && ./bin/dispatch status
```
Expected: build succeeds; `dispatch status` reports `loaded yes` and HTTP `reachable at http://localhost:3456`.

- [ ] **Step 2: Reproduce the original bleed scenario**

Use the `verify` skill (or open `http://localhost:3456` directly). Steps:
1. Open the Control Plane tab for a project with an existing conversation (e.g. **POLYWOOD Analytics**) and let its transcript render.
2. Open the Control Plane tab for a DIFFERENT project (e.g. **Dispatch**), or open a brand-new Control Plane tab.

Expected: the newly-focused tab shows a brief loading spinner then ITS OWN project's transcript (or the empty greeting) — it must NEVER, even for one frame, show the first project's transcript. Switch back and forth between the two Control Plane tabs several times and confirm each always shows only its own project.

- [ ] **Step 3: Record the result**

If the bleed is gone, note it and proceed to Task 4. If any bleed remains, STOP — capture which action triggered it and re-enter `superpowers:systematic-debugging`; do not patch blindly.

---

### Task 4: Verify (and only then fix) the in-tab duplication

The duplication (same transcript rendered 2+ times within one Control Plane tab) was verified to be runtime-injected and transient, NOT persisted (the on-disk transcript is clean) and NOT present in the daemon's current ws replay (149 events, 145 distinct uuids). Its exact frontend trigger was not reproduced during investigation. This task confirms whether the isolation fix already resolved it, and — only if it still reproduces — hands off to a fresh debugging cycle rather than shipping a speculative fix.

**Files:** none unless duplication reproduces.

- [ ] **Step 1: Attempt to reproduce the duplication**

With the rebuilt daemon running, exercise the paths the user reported: rapidly switch between multiple Control Plane tabs, open new Control Plane tabs, and reload the page mid-load, on a project with a short existing coordinator transcript. Watch for the same conversation appearing more than once in a single tab.

- [ ] **Step 2: If it does NOT reproduce**

Record that the per-tab isolation fix resolved the duplication (the shared-subscription churn was the enabler). Close out — no further code change.

- [ ] **Step 3: If it DOES reproduce**

Capture concrete evidence before writing any fix (per systematic-debugging discipline):
- In the browser console, inspect `useOverseer.getState().coordinatorStream` and check for repeated `key`s / repeated message content.
- Capture the ws replay for the affected coordinator to confirm whether the double is server-side or client-side (reuse the approach from the investigation: connect to `ws://localhost:3456/api/terminals/<coordinatorId>/structured-ws?tail=200` and count duplicate `uuid`s).

Then re-enter `superpowers:systematic-debugging` with that evidence to identify the exact trigger (leading candidate: `BootstrapOlderPages` firing `loadOlder()` before the ws replay has settled to real uuids, so the anchor is unresolvable and the newest REST window is prepended without a clean dedup). Do NOT implement a fix until the mechanism is confirmed against the captured evidence.

---

## Notes for the implementer

- **Why gate instead of rewrite the store to per-project maps?** Only one `<OverseerView>` is mounted at a time and `activeId` already tracks the active Control Plane tab's project, so the visible bug is purely temporal (stale reads during the async swap). Gating on `coordinatorProject === activeId` is the smallest change that makes it impossible to render another project's data, and it keeps the coordinator stream on the SAME identity as missions/needs/archived (which all already key on `activeId`). A full per-project-map refactor would touch every consumer for no additional user-visible correctness.
- **Mobile is covered for free:** `mobile/MobileApp.tsx` calls `useProjects.setActive(projectId)` before showing `<OverseerView>`, so `activeId` equals the open Control Plane's project there too; the same gate applies.
