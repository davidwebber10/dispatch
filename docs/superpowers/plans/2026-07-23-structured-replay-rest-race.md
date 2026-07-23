# Structured Replay/REST Race Regression Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-fix the structured-chat transcript duplication / out-of-order / missing-newest-history regression by moving the empty-view rescue to the server and restoring the client's full anchorless-fetch guard.

**Architecture:** PR #9 (`d91fcf6`) forbade `loadOlder()` from ever issuing an *anchorless* first fetch, because an anchorless `GET /conversation` returns the NEWEST window (the whole transcript tail), which races the ws replay and renders the conversation twice/out-of-order. Commit `0b8e106` re-allowed the anchorless fetch when zero items are rendered (to fix a real deadlock: a replay ring holding only non-rendering events — `system/init`, `system/status`, a stale `result` — renders nothing, so no scroll, no `system/inactive` rescue, and the guard bailed silently forever). Its compensating uuid-dedup covers only the whole-event `user`/`assistant` append paths — the **streaming rebuild path** (`content_block_start` appends with synthetic `s-` keys, later *patched* to the real uuid by the whole-`assistant` reconcile) bypasses it entirely, and replay rings are dominated by `stream_event`s. The fix: (1) **server** sends the `system/inactive` rescue whenever the ring has no *renderable* events (not just when empty) — the deadlock ring now gets the REST hydration; (2) **client** hardens the `inactive` hydration so a replayed stale `result` footer doesn't defeat it; (3) **client** restores the full anchorless guard and deletes the now-dead `anchorlessHydratedRef` machinery; (4) **defense-in-depth**: the streaming reconcile drops a rebuilt message whose real uuid is already rendered, so any future overlap regression renders nothing twice.

**Tech Stack:** Node/Express + `ws` (packages/core), React 18 hooks (packages/web), Vitest both sides.

## Global Constraints

- Work on a fresh branch off **updated** `origin/main`; push and open a PR when all tasks pass (controller handles branch/PR).
- Package manager `pnpm`. Core tests: `cd packages/core && pnpm vitest run src/ws/structured.test.ts`. Web tests: `cd packages/web && pnpm vitest run src/components/tabs/chat/useStructuredChat.test.ts`. Web type-check: `cd packages/web && pnpm exec tsc -b`.
- Task order is MANDATORY: Task 3 (removing the client's zero-items anchorless fetch) must land AFTER Tasks 1–2 (the server sentinel + hardened hydration replace it as the empty-view rescue). Otherwise the `0b8e106` deadlock returns.
- The matched/normal paths must be behavior-preserving: live streaming, live whole-event appends, ordinary `loadOlder` paging with an anchor, and the existing "Load earlier messages" button are untouched.
- Line numbers below refer to current `origin/main` (`useStructuredChat.ts` ≈771 lines; `ws/structured.ts` = 62 lines); re-locate by content if drifted.
- End commit messages with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Server — send the `inactive` rescue when the ring has no renderable events

**Files:**
- Modify: `packages/core/src/ws/structured.ts` (sentinel at lines 31–38; add exported helper)
- Test: Create `packages/core/src/ws/structured.test.ts`

**Interfaces:**
- Produces: `export function hasRenderableEvents(events: unknown[]): boolean` — true iff at least one ring event would fold into a visible conversation item client-side. Task 2's client hydration relies on the sentinel now firing for the deadlock ring.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/ws/structured.test.ts`:

```ts
// hasRenderableEvents mirrors the client fold (useStructuredChat's onEvent): an event is
// renderable iff it would produce a visible conversation item. The `system/inactive`
// REST-hydration sentinel fires when the ring holds NO renderable events — covering the
// empty ring AND the 0b8e106 deadlock ring (system/init + system/status + a stale result),
// which is non-empty yet renders nothing.
import { describe, it, expect } from 'vitest';
import { hasRenderableEvents } from './structured.js';

describe('hasRenderableEvents', () => {
  it('empty ring → false (sentinel fires, same as the old events.length === 0 check)', () => {
    expect(hasRenderableEvents([])).toBe(false);
  });

  it('the 0b8e106 deadlock ring (init + status + stale result) → false', () => {
    expect(hasRenderableEvents([
      { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
      { type: 'system', subtype: 'status', status: null },
      { type: 'result', is_error: false },
    ])).toBe(false);
  });

  it('an assistant event with a text block → true', () => {
    expect(hasRenderableEvents([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    ])).toBe(true);
  });

  it('assistant thinking / tool_use / image blocks → true', () => {
    expect(hasRenderableEvents([{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }])).toBe(true);
    expect(hasRenderableEvents([{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: {} }] } }])).toBe(true);
    expect(hasRenderableEvents([{ type: 'assistant', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] } }])).toBe(true);
  });

  it('an assistant event with empty/whitespace-only text and no other blocks → false', () => {
    expect(hasRenderableEvents([{ type: 'assistant', message: { content: [] } }])).toBe(false);
    expect(hasRenderableEvents([{ type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } }])).toBe(false);
  });

  it('a user event with non-empty string content → true; whitespace-only → false', () => {
    expect(hasRenderableEvents([{ type: 'user', message: { role: 'user', content: 'hello' } }])).toBe(true);
    expect(hasRenderableEvents([{ type: 'user', message: { role: 'user', content: '   ' } }])).toBe(false);
  });

  it('a user event with tool_result / text / image blocks → true; empty array → false', () => {
    expect(hasRenderableEvents([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }])).toBe(true);
    expect(hasRenderableEvents([{ type: 'user', message: { content: [{ type: 'text', text: 'q' }] } }])).toBe(true);
    expect(hasRenderableEvents([{ type: 'user', message: { content: [] } }])).toBe(false);
  });

  it('isSynthetic / isMeta user events are skipped by the client → false', () => {
    expect(hasRenderableEvents([{ type: 'user', isSynthetic: true, message: { content: 'injected skill ctx' } }])).toBe(false);
    expect(hasRenderableEvents([{ type: 'user', isMeta: true, message: { content: 'reminder' } }])).toBe(false);
  });

  it('a stream_event content_block_start → true; deltas/message_start alone → false', () => {
    expect(hasRenderableEvents([{ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }])).toBe(true);
    expect(hasRenderableEvents([
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
    ])).toBe(false);
  });

  it('control_request / rate_limit_event / permission-ish noise → false', () => {
    expect(hasRenderableEvents([
      { type: 'control_request', request: { subtype: 'can_use_tool' } },
      { type: 'rate_limit_event' },
    ])).toBe(false);
  });

  it('garbage entries (null, non-objects) are ignored', () => {
    expect(hasRenderableEvents([null, 42, 'nope'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run src/ws/structured.test.ts`
Expected: FAIL — `hasRenderableEvents` is not exported.

- [ ] **Step 3: Implement the helper + widen the sentinel**

In `packages/core/src/ws/structured.ts`, add above `handleStructuredConnection`:

```ts
/**
 * True iff at least one ring event would fold into a VISIBLE conversation item in the
 * client (useStructuredChat's onEvent): a non-synthetic user turn (string or
 * text/tool_result/image blocks), an assistant turn with text/thinking/tool_use/image
 * blocks, or a streamed content_block_start. system/*, result footers, control frames
 * and delta-only stream noise render nothing on their own. Drives the `system/inactive`
 * REST-hydration sentinel below: a ring with no renderable events replays "something"
 * but paints nothing, which used to strand the view (the 0b8e106 deadlock).
 */
export function hasRenderableEvents(events: unknown[]): boolean {
  return events.some((e: any) => {
    if (!e || typeof e !== 'object') return false;
    if (e.type === 'assistant') {
      const c = e.message?.content;
      if (!Array.isArray(c)) return false;
      return c.some((b: any) => b && (b.type === 'tool_use' || b.type === 'thinking' || b.type === 'image'
        || (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0)));
    }
    if (e.type === 'user') {
      if (e.isSynthetic || e.isMeta || !e.message) return false;
      const c = e.message.content;
      if (typeof c === 'string') return c.trim().length > 0;
      if (!Array.isArray(c)) return false;
      return c.some((b: any) => b && (b.type === 'tool_result' || b.type === 'image'
        || (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0)));
    }
    if (e.type === 'stream_event') return e.event?.type === 'content_block_start';
    return false;
  });
}
```

Then replace the sentinel block (current lines 31–38: the comment + `if (events.length === 0 …)` line) with:

```ts
  // Nothing RENDERABLE to replay ⇒ the client would sit on an empty view: the live channel
  // only carries FUTURE turns, and any history not in the ring never reaches it this way.
  // Tell the client to hydrate its initial view from the REST transcript instead. Covers a
  // dead/archived/queued thread (ring empty), an ALIVE thread whose ring is empty after a
  // daemon restart, AND a ring holding only non-rendering events (system/init, a stale
  // result) — that last case previously replayed "something", earned no sentinel, and
  // painted nothing, the deadlock 0b8e106 worked around client-side with an anchorless
  // newest-window fetch (since removed: it raced the replay and doubled transcripts). Sent
  // BEFORE replay; harmless alongside one, since the client only hydrates while nothing
  // conversational is rendered (see useStructuredChat's 'system'/'inactive' handler).
  if (!hasRenderableEvents(events) && ws.readyState === 1) ws.send(JSON.stringify({ type: 'system', subtype: 'inactive' }));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run src/ws/structured.test.ts`
Expected: PASS (11 tests). Then run the full core suite once: `cd packages/core && pnpm test` — expected: no new failures.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ws/structured.ts packages/core/src/ws/structured.test.ts
git commit -m "fix(server): send the inactive rescue when the replay ring has nothing renderable

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Client — harden the `inactive` hydration against stale footers and mid-flight live turns

**Files:**
- Modify: `packages/web/src/components/tabs/chat/useStructuredChat.ts` (the `system`/`inactive` handler, lines 411–428)
- Test: `packages/web/src/components/tabs/chat/useStructuredChat.test.ts` (extend the existing inactive-hydration block at lines 606–652)

**Interfaces:**
- Consumes: the server now sends `system/inactive` for a ring whose only replayed events are non-renderable — which can still deposit a stale `result` FOOTER item client-side (the `result` handler appends a footer for any non-backfill result).
- Produces: hydration applies whenever nothing *conversational* (`kind !== 'result'`) is rendered, prepending the page ABOVE any footer; when a real conversation item exists, the page is discarded AND the paging anchor is left unset.

- [ ] **Step 1: Write the failing tests**

Append inside the inactive-hydration test area (after the test at line 634, `the inactive hydration does not clobber items a live event already populated first`):

```ts
test('the inactive hydration still applies when only a stale result FOOTER rendered (deadlock ring), keeping the footer below the history', async () => {
  vi.spyOn(api, 'getConversation').mockResolvedValue({
    items: [
      { kind: 'user', text: 'from disk', uuid: 'u1', line: 10 },
      { kind: 'assistant', text: 'reply', uuid: 'u2', line: 11 },
    ],
    cursor: 50, startLine: 10, hasMore: false,
  } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'system', subtype: 'inactive' }));
  // The deadlock ring replays a stale (non-backfill) result AFTER the sentinel — the
  // footer item this appends must not defeat the hydration.
  act(() => cbs.onEvent({ type: 'result', is_error: false, duration_ms: 5 }));
  await flushAsync();
  expect(result.current.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'result']);
  expect(result.current.items.map((i) => i.text ?? '')).toEqual(['from disk', 'reply', '']);
});

test('a discarded inactive page leaves the paging anchor UNSET so later paging cannot skip its window', async () => {
  const spy = vi.spyOn(api, 'getConversation')
    .mockResolvedValueOnce({ items: [{ kind: 'user', text: 'newest disk window', uuid: 'w1', line: 30 }], cursor: 50, startLine: 30, hasMore: true } as any)
    .mockResolvedValueOnce({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'system', subtype: 'inactive' }));
  // A live turn lands before the rescue fetch resolves — the page is discarded.
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'live1', message: { content: [{ type: 'text', text: 'live wins' }] } }));
  await flushAsync();
  expect(result.current.items.map((i) => i.text)).toEqual(['live wins']);
  // The next loadOlder must anchor on the live item's uuid — NOT on the discarded page's
  // startLine, which would silently skip everything in that dropped window.
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(spy).toHaveBeenLastCalledWith('t1', { before: undefined, beforeUuid: 'live1', limit: 120 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/web && pnpm vitest run src/components/tabs/chat/useStructuredChat.test.ts -t 'inactive'`
Expected: the two new tests FAIL — footer test gets `['user','assistant']` order wrong (page discarded: items stay `['result']` shape) and the anchor test sees `before: 30`.

- [ ] **Step 3: Implement the hardened hydration**

Replace the `.then((conv) => { … })` body of the `system`/`inactive` handler (lines 417–422) with:

```ts
            .then((conv) => {
              if (tok !== pageTokenRef.current) return; // thread switched / ws reset mid-flight
              // Apply only while nothing CONVERSATIONAL is rendered. A ring that earned this
              // rescue replays no conversation items, but can still deposit a stale `result`
              // FOOTER (the result handler appends one for any non-backfill result) — a footer
              // alone doesn't own the view: hydrate and keep it BELOW the history, where the
              // newest turn's footer belongs. A real conversation item (a live turn that
              // started mid-flight) means the stream owns the view — discard the page AND
              // leave the paging anchor unset: anchoring at this page's startLine while
              // dropping its content would leave a gap later loadOlder() pages right past.
              const conversational = (it: ConvItem) => it.kind !== 'result';
              if (itemsRef.current.some(conversational)) return;
              oldestLineRef.current = conv.startLine;
              hasMoreRef.current = conv.hasMore; setHasMore(conv.hasMore);
              if (conv.items.length) setItems((prev) => (prev.some(conversational) ? prev : [...conv.items, ...prev]));
            })
```

(`ConvItem` is already imported at the top of the file. The inner `prev.some(conversational)` re-check is the authoritative guard — `itemsRef` syncs in a passive effect and can lag a just-committed live event; the outer check gates only the anchor side-effects.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/web && pnpm vitest run src/components/tabs/chat/useStructuredChat.test.ts`
Expected: PASS, including the three pre-existing inactive tests (lines 606, 625, 634) — the hydrate-once latch and live-wins discard behavior are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tabs/chat/useStructuredChat.ts packages/web/src/components/tabs/chat/useStructuredChat.test.ts
git commit -m "fix(chat): inactive hydration survives a stale footer and never anchors a discarded page

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Client — restore the full anchorless-fetch guard, delete the dead dedup machinery

**Files:**
- Modify: `packages/web/src/components/tabs/chat/useStructuredChat.ts` (guard at lines 711–734; `anchorlessHydratedRef` at 254–259 with resets at 286, 295, 388; `appendItems` at 354–367)
- Test: `packages/web/src/components/tabs/chat/useStructuredChat.test.ts` (replace the test at line 739 `DEADLOCK FIX: …`; rewrite the test at line 784 `REGRESSION: a mount-time loadOlder racing the ws replay …`)

**Interfaces:**
- Consumes: Tasks 1–2 — the server `system/inactive` sentinel (fires for any ring with no renderable events) + the hardened client hydration are now the ONLY empty-view rescue, so the zero-items anchorless fetch is removable without re-creating the deadlock.
- Produces: `loadOlder()` never fetches without an anchor (`beforeUuid` on the first call, numeric `before` after); `appendItems` is a plain append again; `anchorlessHydratedRef` no longer exists.

- [ ] **Step 1: Update the tests to the restored contract**

REPLACE the test at line 739 (`DEADLOCK FIX: with ZERO items rendered, loadOlder DOES issue the anchorless REST fetch (initial hydration)`) with:

```ts
test('with ZERO items rendered, loadOlder does NOT fetch — the newest window is owned by the ws replay / server inactive rescue', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  expect(result.current.items).toHaveLength(0);
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(spy).not.toHaveBeenCalled(); // an anchorless fetch returns the NEWEST window and races the replay
  expect(result.current.loadingOlder).toBe(false);
});
```

REWRITE the test at line 784 (`REGRESSION: a mount-time loadOlder racing the ws replay does not double the transcript`) — same name, new mechanism:

```ts
test('REGRESSION: a mount-time loadOlder racing the ws replay does not double the transcript (no anchorless fetch is ever issued)', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({
    items: [
      { kind: 'user', text: 'q', uuid: 'u1', line: 0 },
      { kind: 'assistant', text: 'a', uuid: 'u2', line: 1 },
    ],
    cursor: 2, startLine: 0, hasMore: false,
  } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => { result.current.loadOlder(); }); // bootstrap fires on mount, items still empty
  await flushAsync();
  expect(spy).not.toHaveBeenCalled(); // the newest-window fetch that caused the doubling never happens
  // The ws replay lands the turns exactly once, in order.
  act(() => cbs.onEvent({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } }));
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'u2', message: { content: [{ type: 'text', text: 'a' }] } }));
  expect(result.current.items.map((i) => i.text)).toEqual(['q', 'a']);
});
```

Leave the two guard tests at lines 752 and 769 untouched — they encode behavior that survives.

- [ ] **Step 2: Run tests to verify the two updated ones fail**

Run: `cd packages/web && pnpm vitest run src/components/tabs/chat/useStructuredChat.test.ts`
Expected: exactly the two updated tests FAIL (`getConversation` IS still called with `{ before: undefined, limit: 120 }`); everything else passes.

- [ ] **Step 3: Restore the guard and remove the dead machinery**

In `packages/web/src/components/tabs/chat/useStructuredChat.ts`:

(a) DELETE the `anchorlessHydratedRef` declaration and its comment (lines 254–259), and its three resets (`anchorlessHydratedRef.current = false;` at lines 286, 295, and 388).

(b) Replace `appendItems` (lines 354–367) with a plain append:

```ts
    // Append whole-event items. Plain append: the anchorless newest-window fetch that once
    // required uuid-dedup here is gone — loadOlder never fetches without an anchor, and the
    // inactive-rescue page only lands on a view with no conversation items to collide with
    // (see the 'system'/'inactive' handler below).
    const appendItems = (add: ConvItem[]) => {
      if (add.length) setItems((p) => [...p, ...add]);
    };
```

(c) Replace the narrowed guard block in `loadOlder` (the comment + two lines at 715–734, i.e. everything from `// ANCHORLESS-FETCH GUARD (narrowed …` through `if (firstCall && !beforeUuid) anchorlessHydratedRef.current = true;`) with:

```ts
    // ANCHORLESS-FETCH GUARD: on the first call, if no rendered item carries a real uuid yet
    // (items empty, mid-stream synthetic keys only, or optimistic echoes), do NOT fetch. An
    // anchorless request makes getConversation return the NEWEST window — the whole transcript
    // tail — which collides with the ws replay and renders the conversation twice / out of
    // order (fixed in d91fcf6, regressed by 0b8e106's zero-items exception, re-fixed here).
    // loadOlder serves strictly-older history; the newest window is owned by the ws replay,
    // and a ring with nothing renderable gets the server's `system/inactive` REST rescue
    // instead (ws/structured.ts hasRenderableEvents + the 'inactive' handler above). Bail and
    // let BootstrapOlderPages / a near-top scroll / the Load-earlier button retry once the
    // replay settles an anchor.
    if (firstCall && !beforeUuid) return;
```

- [ ] **Step 4: Run tests to verify everything passes**

Run: `cd packages/web && pnpm vitest run src/components/tabs/chat/useStructuredChat.test.ts`
Expected: PASS — including the untouched guard tests (752, 769), the Task 2 tests, and both updated tests. Then type-check: `cd packages/web && pnpm exec tsc -b` — expected clean (the removed ref has no other references; verify with `rg -n anchorlessHydratedRef packages/web/src` → no matches).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tabs/chat/useStructuredChat.ts packages/web/src/components/tabs/chat/useStructuredChat.test.ts
git commit -m "fix(chat): restore the full anchorless loadOlder guard (0b8e106 regression)

The zero-items exception let a mount-time loadOlder fetch the NEWEST window and race
the ws replay; the compensating dedup missed the streaming rebuild path, duplicating
and reordering transcripts. The server's widened inactive rescue now owns that case.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Client — defense-in-depth: drop a streamed rebuild whose reconciled uuid is already rendered

**Files:**
- Modify: `packages/web/src/components/tabs/chat/useStructuredChat.ts` (the streaming reconcile inside the `assistant` handler, lines 533–563)
- Test: `packages/web/src/components/tabs/chat/useStructuredChat.test.ts` (append near the upgrade tests at lines 683–712)

**Interfaces:**
- Consumes: the whole-`assistant` reconcile's `uuid` (real transcript identity) and `blockKeys` (this burst's synthetic `s-` keys).
- Produces: when `uuid` is already rendered by an item outside the burst, the burst's items are removed instead of upgraded — one identity, one rendered copy, regardless of how a future overlap arises.

- [ ] **Step 1: Write the failing test**

Append after the test at line 698 (`streaming mode: a reconciled tool item gets its synthetic key upgraded …`):

```ts
test('DEFENSE: a streamed rebuild whose reconciled uuid is ALREADY rendered is dropped, not duplicated', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  // A copy of this message is already rendered (e.g. a REST-hydrated page).
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'U', message: { content: [{ type: 'text', text: 'answer' }] } }));
  expect(result.current.items.map((i) => i.text)).toEqual(['answer']);
  // A replayed stream burst rebuilds the SAME message: message_start → block → delta →
  // whole-assistant reconcile carrying the same transcript uuid.
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'text' })));
  act(() => cbs.onEvent(textDelta(0, 'answer')));
  drainRaf();
  expect(result.current.items).toHaveLength(2); // burst item visible mid-stream (pre-reconcile)
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'U', message: { content: [{ type: 'text', text: 'answer' }] } }));
  expect(result.current.items.filter((i) => i.text === 'answer')).toHaveLength(1); // dropped, not upgraded
  expect(result.current.items.filter((i) => i.uuid === 'U')).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && pnpm vitest run src/components/tabs/chat/useStructuredChat.test.ts -t 'DEFENSE'`
Expected: FAIL — two items with text 'answer' (the burst item gets upgraded to uuid 'U' alongside the original).

- [ ] **Step 3: Implement the drop inside the reconcile updater**

In the streaming reconcile (inside `if (streamingRef.current) { … }`), the current `setItems` updater begins:

```ts
              setItems((p) => {
                const haveIds = new Set(p.filter((i) => i.kind === 'tool' && i.toolId).map((i) => i.toolId));
```

Insert the drop check as the first statement of the updater (before `const haveIds`):

```ts
              setItems((p) => {
                // DEFENSE-IN-DEPTH (replay/REST overlap): if this message's real uuid is already
                // rendered by an item OUTSIDE this stream burst (a REST-hydrated copy), drop the
                // burst's rebuilt items instead of upgrading them — upgrading would leave two
                // items sharing one identity, i.e. the same turn rendered twice. With the
                // anchorless fetch gone this cannot occur today; it exists so a future overlap
                // regression duplicates nothing. (Burst items still carry synthetic `s-` keys
                // here, so `it.uuid === uuid` can only match an outside copy.)
                if (uuid && p.some((it) => it.uuid === uuid)) {
                  return p.filter((it) => !(it.uuid && blockKeys.has(it.uuid)));
                }
                const haveIds = new Set(p.filter((i) => i.kind === 'tool' && i.toolId).map((i) => i.toolId));
```

The rest of the updater (the `p.map` patch loop and the missing-tools append) is unchanged.

- [ ] **Step 4: Run tests to verify everything passes**

Run: `cd packages/web && pnpm vitest run src/components/tabs/chat/useStructuredChat.test.ts`
Expected: PASS — including the two pre-existing upgrade tests (lines 683, 698: normal path, no pre-rendered copy, so the drop check no-ops) and the streaming no-dup test (line 59).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tabs/chat/useStructuredChat.ts packages/web/src/components/tabs/chat/useStructuredChat.test.ts
git commit -m "fix(chat): reconcile drops a streamed rebuild whose uuid is already rendered

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full suites + types + build**

Run from repo root:
```bash
pnpm --filter dispatch-web test && (cd packages/core && pnpm test) && (cd packages/web && pnpm exec tsc -b) && pnpm build
```
Expected: all suites pass, types clean, build succeeds.

- [ ] **Step 2: Hand off for live verification (outside Dispatch)**

Live verification requires `dispatch restart`, which kills any Dispatch-hosted session — it must be run from a plain terminal. The PR body must list it as the merge gate:
1. `pnpm build && ./bin/dispatch restart && ./bin/dispatch status` (healthy).
2. Open Control Plane tabs / agent Pretty chats for projects with existing history: confirm the newest turns render at the bottom, exactly once, in order — across fresh opens, rapid tab switches, and mid-load reloads.
3. Confirm the `0b8e106` deadlock stays fixed: a thread whose ring holds only non-rendering events (e.g. freshly daemon-restarted idle thread that was never backfilled) still shows its history on open.

---

## Notes for the implementer

- **Why the deadlock can't return:** the ring that stranded `0b8e106`'s view replays nothing renderable → Task 1's sentinel fires → Task 2's hydration paints the REST page even if a stale footer replayed. The client-side anchorless fetch was a workaround at the wrong layer; the server knows exactly what the ring contains.
- **Why not keep the armed dedup too:** after Task 3 the whole-event append paths can no longer see overlapped content (loadOlder is strictly-older, the rescue page only lands on an empty-of-conversation view). Dead arming code invites the next person to widen it again. Task 4's reconcile drop is the one overlap defense kept, because it sits on the path the `0b8e106` dedup provably missed.
- **`itemsRef` lag:** the outer `itemsRef.current.some(conversational)` check in Task 2 gates only the anchor side-effects; the inner `prev.some(conversational)` inside `setItems` is the authoritative duplication guard (pure function of the real state, StrictMode-safe).
