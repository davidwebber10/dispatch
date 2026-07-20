# Typewriter Label Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a thread auto-names itself while the user is looking at the sidebar thread list, the old default label backspaces away character-by-character and the new name types in behind a blinking caret.

**Architecture:** Purely client-side. The daemon already ships `labelSource: 'user' | 'default' | 'auto'` on every terminal (`packages/core/src/db/terminals.ts:68`, passed through untouched by `res.json(terminals)` at `packages/core/src/routes/terminals.ts:55-62`) — the web `Terminal` type simply never declared the field. The auto-namer broadcasts `session:tabs-changed` after renaming (`packages/core/src/sessions/thread-auto-namer.ts:139`), which the tabs store already handles by re-running `loadTabs`. So `loadTabs` diffing its own previous state against the incoming list — `prev.labelSource === 'default'` → `next.labelSource === 'auto'` — *is* the auto-naming event, with no new server code, no new socket message, and no presence tracking.

**Tech Stack:** React 18 + TypeScript, zustand (vanilla `create`, no middleware), vitest + jsdom + React Testing Library.

> **AMENDED AFTER IMPLEMENTATION — read before trusting the code blocks below.**
> Review found real defects in this plan's example code. The blocks in Tasks 2 and 3
> are the *starting point that was implemented*, not the code that shipped:
>
> - **Task 2 Step 4(e)** shows `loadTabs` with no request sequencing. Two overlapping
>   refreshes for one project could land out of order, regress `byProject` to a stale
>   label, and make a later refresh re-detect an already-consumed transition (phantom
>   replay). Shipped code adds a per-project epoch guard **and** an in-flight promise
>   so a superseded call awaits the winner — an early `return` alone silently breaks
>   `loadTabs`'s "state is applied when I resolve" contract, which `hydrate()` and
>   ~20 other call sites depend on.
> - **Task 3 Step 3** shows the animation kicked off from `useEffect`, which runs
>   *after* paint: the row painted the final name for one frame, then reverted to the
>   stale label before backspacing. Shipped code uses `useLayoutEffect` plus a lazy
>   `useState` initializer that peeks the store without consuming it. It also adds a
>   `consumedRef` so React StrictMode's dev-only double-invoke doesn't eat the
>   consume-once entry and suppress the animation in local dev.
> - The spec's "Timers via `setInterval`" is wrong for a two-phase variable-rate
>   animation; the implementation uses a chained `setTimeout`.
>
> See `docs/superpowers/verification/2026-07-19-typewriter-label-runtime.md` for the
> runtime evidence, and the git history for the actual shipped implementation.

## Global Constraints

- **No server-side changes.** Nothing in `packages/core` may be modified. `labelSource` is already on the wire; only the web-side type declaration is missing.
- **No new dependencies.** No animation library, no `useMediaQuery` package.
- **Timings, copied verbatim from the spec:** delete `25ms`/char, type `35ms`/char, caret blink `530ms`, freshness window `3000ms`.
- **Scope is the sidebar thread row only.** Do not touch the top tab bar, pinned-threads view, or overseer chips.
- **Fail quiet on old daemons.** A missing `labelSource` is treated as `'user'`, which can never produce a transition and therefore never animates.
- **Animation is presentation only.** The store's `tab.label` is always the truth; unmounting mid-animation must leave the correct final label behind.
- **House style:** no semicolon-free style, 2-space indent, inline `style={{}}` objects in sidebar components, `test()` (not `describe`/`it`) in store tests.

---

### Task 1: `usePrefersReducedMotion` hook

There is no `prefers-reduced-motion` handling and no `useMediaQuery` hook anywhere in `packages/web`. Build one mirroring the house idiom in `useIsMobile.ts` — note the `typeof window.matchMedia !== 'function'` guard, which matters because `src/test/setup.ts` does **not** stub `matchMedia`, so any test that doesn't opt in relies on that guard to avoid throwing.

**Files:**
- Create: `packages/web/src/hooks/usePrefersReducedMotion.ts`
- Test: `packages/web/src/hooks/usePrefersReducedMotion.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `usePrefersReducedMotion(): boolean` — `true` when the user has requested reduced motion, `false` in jsdom/SSR where `matchMedia` is absent.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/hooks/usePrefersReducedMotion.test.ts`:

```ts
import { expect, test, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

afterEach(() => { vi.restoreAllMocks(); delete (window as any).matchMedia; });

function stubMatchMedia(matches: boolean) {
  const listeners: Array<() => void> = [];
  const mq = {
    matches,
    addEventListener: (_: string, cb: () => void) => { listeners.push(cb); },
    removeEventListener: vi.fn(),
  };
  (window as any).matchMedia = vi.fn(() => mq);
  return { mq, fire: (next: boolean) => { mq.matches = next; listeners.forEach((cb) => cb()); } };
}

test('returns false when matchMedia is unavailable (jsdom default)', () => {
  const { result } = renderHook(() => usePrefersReducedMotion());
  expect(result.current).toBe(false);
});

test('returns true when the user prefers reduced motion', () => {
  stubMatchMedia(true);
  const { result } = renderHook(() => usePrefersReducedMotion());
  expect(result.current).toBe(true);
});

test('reacts to a live preference change', () => {
  const { fire } = stubMatchMedia(false);
  const { result } = renderHook(() => usePrefersReducedMotion());
  expect(result.current).toBe(false);
  act(() => fire(true));
  expect(result.current).toBe(true);
});

test('removes its listener on unmount', () => {
  const { mq } = stubMatchMedia(false);
  const { unmount } = renderHook(() => usePrefersReducedMotion());
  unmount();
  expect(mq.removeEventListener).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/hooks/usePrefersReducedMotion.test.ts`
Expected: FAIL — `Failed to resolve import "./usePrefersReducedMotion"`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/hooks/usePrefersReducedMotion.ts`:

```ts
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/** Mirrors the useIsMobile idiom. Returns false where matchMedia is absent (jsdom, SSR). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/hooks/usePrefersReducedMotion.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hooks/usePrefersReducedMotion.ts packages/web/src/hooks/usePrefersReducedMotion.test.ts
git commit -m "feat(web): usePrefersReducedMotion hook"
```

---

### Task 2: Detect the default→auto transition in the tabs store

`loadTabs` (`packages/web/src/stores/tabs.ts:91-97`) is the only place the terminal list is refreshed, and `session:tabs-changed` routes through it (line 208-210). At line 95, `get().byProject[projectId]` is still the *previous* array while `tabs` is the incoming one — that is the diff point.

Recorded entries are **consume-once and perishable**: a mounted label consumes and removes its entry; anything older than 3000ms is pruned unconsumed. A collapsed card never mounts a label, so it never consumes, and the entry ages out instead of animating later.

`persist()` (line 64-66) deliberately does **not** persist `byProject`, so on a fresh page load there is no previous array, no diff, and therefore no animation on reload. Do not add `autoNamed` to `persist()`.

**Files:**
- Modify: `packages/web/src/api/types.ts:20-34` (add one field to `Terminal`)
- Modify: `packages/web/src/stores/tabs.ts` (interface `TabsState`, initial state, `loadTabs`, new action)
- Test: `packages/web/src/stores/tabs.autoname.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `Terminal.labelSource?: 'user' | 'default' | 'auto'`
  - `TabsState.autoNamed: Record<string, AutoNameEntry>` where `AutoNameEntry = { from: string; to: string; at: number }`
  - `TabsState.consumeAutoName: (id: string) => { from: string; to: string } | null` — returns and removes a fresh entry, removes-and-returns-null for a stale one, returns null when absent.
  - Exported constant `AUTO_NAME_TTL_MS = 3000`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/stores/tabs.autoname.test.ts`:

```ts
import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { useTabs, AUTO_NAME_TTL_MS } from './tabs';
import { api } from '../api/client';

const NOW = new Date('2026-07-19T12:00:00.000Z').getTime();

function term(over: Record<string, unknown>) {
  return { id: 't1', sessionId: 's1', label: 'Claude Code', labelSource: 'default', ...over } as any;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useTabs.setState({ byProject: {}, tabSession: {}, autoNamed: {} } as any);
  vi.restoreAllMocks();
});
afterEach(() => { vi.useRealTimers(); });

test('records a transition when a default label becomes auto', async () => {
  useTabs.setState({ byProject: { s1: [term({})] } } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Fix login bug', labelSource: 'auto' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed['t1']).toEqual({ from: 'Claude Code', to: 'Fix login bug', at: NOW });
});

test('records nothing on first load — no previous list to diff', async () => {
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Fix login bug', labelSource: 'auto' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed).toEqual({});
});

test('records nothing on an auto -> auto refresh', async () => {
  useTabs.setState({ byProject: { s1: [term({ label: 'Fix login bug', labelSource: 'auto' })] } } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Fix login bug', labelSource: 'auto' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed).toEqual({});
});

test('records nothing for a user rename (default -> user)', async () => {
  useTabs.setState({ byProject: { s1: [term({})] } } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'My thread', labelSource: 'user' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed).toEqual({});
});

test('records nothing when the label did not actually change', async () => {
  useTabs.setState({ byProject: { s1: [term({})] } } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Claude Code', labelSource: 'auto' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed).toEqual({});
});

test('treats a missing labelSource as user — old daemons never animate', async () => {
  useTabs.setState({ byProject: { s1: [term({ labelSource: undefined })] } } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Fix login bug', labelSource: undefined })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed).toEqual({});
});

test('consumeAutoName returns a fresh entry once, then null', () => {
  useTabs.setState({ autoNamed: { t1: { from: 'a', to: 'b', at: NOW } } } as any);
  expect(useTabs.getState().consumeAutoName('t1')).toEqual({ from: 'a', to: 'b' });
  expect(useTabs.getState().consumeAutoName('t1')).toBeNull();
  expect(useTabs.getState().autoNamed['t1']).toBeUndefined();
});

test('consumeAutoName drops a stale entry without animating', () => {
  useTabs.setState({ autoNamed: { t1: { from: 'a', to: 'b', at: NOW - AUTO_NAME_TTL_MS - 1 } } } as any);
  expect(useTabs.getState().consumeAutoName('t1')).toBeNull();
  expect(useTabs.getState().autoNamed['t1']).toBeUndefined();
});

test('consumeAutoName returns null for an unknown id', () => {
  expect(useTabs.getState().consumeAutoName('nope')).toBeNull();
});

test('loadTabs prunes stale entries left behind by collapsed cards', async () => {
  useTabs.setState({
    byProject: { s1: [term({})] },
    autoNamed: { old: { from: 'a', to: 'b', at: NOW - AUTO_NAME_TTL_MS - 1 } },
  } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ label: 'Fix login bug', labelSource: 'auto' })]);
  await useTabs.getState().loadTabs('s1');
  expect(useTabs.getState().autoNamed['old']).toBeUndefined();
  expect(useTabs.getState().autoNamed['t1']).toBeDefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/stores/tabs.autoname.test.ts`
Expected: FAIL — `AUTO_NAME_TTL_MS` is not exported and `consumeAutoName is not a function`.

- [ ] **Step 3: Add `labelSource` to the web `Terminal` type**

In `packages/web/src/api/types.ts`, inside `export interface Terminal`, add the field directly after `label: string;`:

```ts
  label: string;
  /** Set by the daemon since v2.2.0. Absent on older daemons — treat as 'user'. */
  labelSource?: 'user' | 'default' | 'auto';
```

- [ ] **Step 4: Add the store state, the diff, and the action**

In `packages/web/src/stores/tabs.ts`:

(a) Above the `TabsState` interface, add the entry type and the TTL:

```ts
export const AUTO_NAME_TTL_MS = 3000;

/** A live default -> auto label transition, awaiting a mounted label to animate it. */
export interface AutoNameEntry { from: string; to: string; at: number }
```

(b) In the `TabsState` interface, add the field alongside the other state fields (near `byProject`, before the actions block):

```ts
  autoNamed: Record<string, AutoNameEntry>;
```

and add the action signature in the actions block:

```ts
  consumeAutoName: (id: string) => { from: string; to: string } | null;
```

(c) Beside the other module-level helpers (near `findTerminal`), add:

```ts
function pruneAutoNamed(entries: Record<string, AutoNameEntry>, now: number): Record<string, AutoNameEntry> {
  const kept: Record<string, AutoNameEntry> = {};
  for (const [id, e] of Object.entries(entries)) if (now - e.at <= AUTO_NAME_TTL_MS) kept[id] = e;
  return kept;
}

/** A rename is animatable only when the daemon just switched this label from its default to a generated one. */
function detectAutoNames(prev: Terminal[] | undefined, next: Terminal[], now: number): Record<string, AutoNameEntry> {
  if (!prev) return {}; // first load for this project — nothing to diff, so a reload can never animate
  const byId = new Map(prev.map((t) => [t.id, t]));
  const found: Record<string, AutoNameEntry> = {};
  for (const n of next) {
    const p = byId.get(n.id);
    if (!p) continue;
    if ((p.labelSource ?? 'user') !== 'default') continue;
    if (n.labelSource !== 'auto') continue;
    if (p.label === n.label) continue;
    found[n.id] = { from: p.label, to: n.label, at: now };
  }
  return found;
}
```

(d) In the `create` object literal, add the initial value next to `byProject: {}`:

```ts
  autoNamed: {},
```

(e) Replace `loadTabs` (currently lines 91-97) with:

```ts
  loadTabs: async (projectId) => {
    const tabs = await api.listTerminals(projectId);
    const now = Date.now();
    const prev = get().byProject[projectId];
    const tabSession = { ...get().tabSession };
    for (const t of tabs) tabSession[t.id] = t.sessionId;
    const autoNamed = { ...pruneAutoNamed(get().autoNamed, now), ...detectAutoNames(prev, tabs, now) };
    set({ byProject: { ...get().byProject, [projectId]: tabs }, tabSession, autoNamed });
    persist(get()); // note: persist() intentionally omits byProject and autoNamed
  },
```

(f) Add the action to the same object literal, next to the other actions:

```ts
  consumeAutoName: (id) => {
    const entry = get().autoNamed[id];
    if (!entry) return null;
    const rest = { ...get().autoNamed };
    delete rest[id];
    set({ autoNamed: rest });
    if (Date.now() - entry.at > AUTO_NAME_TTL_MS) return null;
    return { from: entry.from, to: entry.to };
  },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/stores/tabs.autoname.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Run the full web suite for regressions**

Run: `pnpm --filter dispatch-web test`
Expected: PASS — 524 existing tests plus the new ones, no failures. `loadTabs` changed, so `tabs.test.ts`, `tabs-alerts.test.ts`, `tabs-dirty.test.ts`, and `tabs.reorder.test.ts` are the ones to watch.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/api/types.ts packages/web/src/stores/tabs.ts packages/web/src/stores/tabs.autoname.test.ts
git commit -m "feat(web): detect live default->auto label transitions in the tabs store"
```

---

### Task 3: `ThreadLabel` component and the caret

`ThreadRow` is a module-private component inside `ProjectCard.tsx` (declared line 60, rendered from line 320 and line 421) — it is **not** exported and there is no `ThreadRow.tsx`. Tests therefore render `<ProjectCard>` and assert on the row, exactly as `ThreadRow.autoArchive.test.tsx` does.

The label span (`ProjectCard.tsx:130`) is `whiteSpace: 'nowrap'` with ellipsis overflow. Keep that span and its styles byte-identical so row layout cannot jank — `ThreadLabel` renders *that same span*, with the caret as a zero-width bordered child rather than an extra text character.

**Files:**
- Create: `packages/web/src/components/sidebar/ThreadLabel.tsx`
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx:130` (swap the span for `<ThreadLabel tab={tab} />`) and its import block
- Modify: `packages/web/src/theme.css` (caret keyframes)
- Test: `packages/web/src/components/sidebar/ThreadLabel.test.tsx`

**Interfaces:**
- Consumes: `usePrefersReducedMotion()` from Task 1; `useTabs.getState().consumeAutoName(id)` and `AutoNameEntry` from Task 2.
- Produces: `ThreadLabel({ tab }: { tab: Terminal })` — a drop-in replacement for the label span.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/sidebar/ThreadLabel.test.tsx`:

```tsx
import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ThreadLabel } from './ThreadLabel';
import { useTabs } from '../../stores/tabs';

const NOW = new Date('2026-07-19T12:00:00.000Z').getTime();
const tab = { id: 't1', sessionId: 's1', label: 'Fix login bug', labelSource: 'auto' } as any;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useTabs.setState({ autoNamed: {} } as any);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete (window as any).matchMedia; });

function seed() {
  useTabs.setState({ autoNamed: { t1: { from: 'Claude Code', to: 'Fix login bug', at: NOW } } } as any);
}

test('renders the plain label when there is nothing to animate', () => {
  render(<ThreadLabel tab={tab} />);
  expect(screen.getByText('Fix login bug')).toBeInTheDocument();
  expect(document.querySelector('.dispatch-caret')).toBeNull();
});

test('backspaces the old label, then types the new one', () => {
  seed();
  const { container } = render(<ThreadLabel tab={tab} />);
  const text = () => container.querySelector('[data-testid="thread-label-text"]')!.textContent;

  expect(text()).toBe('Claude Code');
  act(() => { vi.advanceTimersByTime(25 * 3); });
  expect(text()).toBe('Claude C');              // three characters deleted

  act(() => { vi.advanceTimersByTime(25 * 8); });
  expect(text()).toBe('');                       // fully backspaced

  act(() => { vi.advanceTimersByTime(35 * 3); });
  expect(text()).toBe('Fix');                    // typing in

  act(() => { vi.advanceTimersByTime(35 * 40); });
  expect(text()).toBe('Fix login bug');          // settled on the truth
});

test('shows a caret during the animation and removes it after', () => {
  seed();
  const { container } = render(<ThreadLabel tab={tab} />);
  expect(container.querySelector('.dispatch-caret')).not.toBeNull();
  act(() => { vi.advanceTimersByTime(25 * 12 + 35 * 40); });
  expect(container.querySelector('.dispatch-caret')).toBeNull();
});

test('consumes the entry once — a re-render does not replay it', () => {
  seed();
  const { rerender, container } = render(<ThreadLabel tab={tab} />);
  act(() => { vi.advanceTimersByTime(25 * 12 + 35 * 40); });
  expect(useTabs.getState().autoNamed['t1']).toBeUndefined();
  rerender(<ThreadLabel tab={{ ...tab }} />);
  expect(container.querySelector('[data-testid="thread-label-text"]')!.textContent).toBe('Fix login bug');
  expect(container.querySelector('.dispatch-caret')).toBeNull();
});

test('reduced motion consumes the entry but swaps instantly', () => {
  (window as any).matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  seed();
  const { container } = render(<ThreadLabel tab={tab} />);
  expect(container.querySelector('[data-testid="thread-label-text"]')!.textContent).toBe('Fix login bug');
  expect(container.querySelector('.dispatch-caret')).toBeNull();
  expect(useTabs.getState().autoNamed['t1']).toBeUndefined();
});

test('a user rename mid-animation cancels it and shows the new truth', () => {
  seed();
  const { rerender, container } = render(<ThreadLabel tab={tab} />);
  act(() => { vi.advanceTimersByTime(25 * 3); });
  rerender(<ThreadLabel tab={{ ...tab, label: 'My name', labelSource: 'user' }} />);
  expect(container.querySelector('[data-testid="thread-label-text"]')!.textContent).toBe('My name');
  expect(container.querySelector('.dispatch-caret')).toBeNull();
});

test('exposes the true label to assistive tech while animating', () => {
  seed();
  render(<ThreadLabel tab={tab} />);
  expect(screen.getByLabelText('Fix login bug')).toBeInTheDocument();
});

test('unmounting mid-animation clears its timer and stops rendering', () => {
  seed();
  const clear = vi.spyOn(globalThis, 'clearTimeout');
  const { unmount, container } = render(<ThreadLabel tab={tab} />);
  act(() => { vi.advanceTimersByTime(25 * 3); });
  const calls = clear.mock.calls.length;
  unmount();
  expect(clear.mock.calls.length).toBeGreaterThan(calls); // cleanup ran
  act(() => { vi.advanceTimersByTime(5000); });
  expect(container.querySelector('[data-testid="thread-label-text"]')).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter dispatch-web exec vitest run src/components/sidebar/ThreadLabel.test.tsx`
Expected: FAIL — `Failed to resolve import "./ThreadLabel"`.

- [ ] **Step 3: Write the component**

Create `packages/web/src/components/sidebar/ThreadLabel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { Terminal } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

const DELETE_MS = 25;
const TYPE_MS = 35;

/**
 * The thread-row label. Normally renders `tab.label` verbatim; when the tabs store
 * has just observed this thread auto-name itself, it backspaces the old label away
 * and types the new one in. The store is always the truth — this is presentation
 * only, so an unmount mid-animation simply leaves the final label behind.
 */
export function ThreadLabel({ tab }: { tab: Terminal }) {
  // null means "not animating — show tab.label"
  const [typed, setTyped] = useState<string | null>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    // getState() rather than a selector: consuming must not re-subscribe this component.
    const entry = useTabs.getState().consumeAutoName(tab.id);
    if (!entry || reduced) {
      setTyped(null); // also cancels any in-flight animation when tab.label changes under us
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const del = (n: number) => {
      if (cancelled) return;
      setTyped(entry.from.slice(0, n));
      timer = n > 0 ? setTimeout(() => del(n - 1), DELETE_MS) : setTimeout(() => type(1), TYPE_MS);
    };
    const type = (n: number) => {
      if (cancelled) return;
      setTyped(entry.to.slice(0, n));
      if (n < entry.to.length) timer = setTimeout(() => type(n + 1), TYPE_MS);
      else timer = setTimeout(() => { if (!cancelled) setTyped(null); }, TYPE_MS);
    };

    del(entry.from.length);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // tab.label in deps: a concurrent user rename must cancel the animation and show truth
  }, [tab.id, tab.label, reduced]);

  const animating = typed !== null;
  return (
    <span
      style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      aria-label={tab.label}
    >
      <span data-testid="thread-label-text">{animating ? typed : tab.label}</span>
      {animating && <span className="dispatch-caret" aria-hidden="true" />}
    </span>
  );
}
```

- [ ] **Step 4: Add the caret styles**

Append to `packages/web/src/theme.css`:

```css
/* Typewriter caret for auto-named thread labels (see ThreadLabel.tsx). */
.dispatch-caret {
  display: inline-block;
  width: 0;
  height: 1em;
  vertical-align: text-bottom;
  border-left: 1px solid currentColor;
  animation: dispatch-caret-blink 530ms step-end infinite;
}

@keyframes dispatch-caret-blink {
  50% { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .dispatch-caret { animation: none; }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter dispatch-web exec vitest run src/components/sidebar/ThreadLabel.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 6: Wire it into the thread row**

In `packages/web/src/components/sidebar/ProjectCard.tsx`, add to the imports:

```tsx
import { ThreadLabel } from './ThreadLabel';
```

Then replace line 130 exactly:

```tsx
// before
<span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.label}</span>
// after
<ThreadLabel tab={tab} />
```

- [ ] **Step 7: Run the sidebar tests and typecheck**

Run: `pnpm --filter dispatch-web exec vitest run src/components/sidebar/`
Expected: PASS — including the pre-existing `ThreadRow.autoArchive.test.tsx` and `ProjectSidebar.test.tsx`, which assert on label text via `screen.getByText` and must keep matching.

Run: `pnpm --filter dispatch-web exec tsc -b`
Expected: no output (clean).

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/components/sidebar/ThreadLabel.tsx packages/web/src/components/sidebar/ThreadLabel.test.tsx packages/web/src/components/sidebar/ProjectCard.tsx packages/web/src/theme.css
git commit -m "feat(web): typewriter animation for auto-named thread labels"
```

---

### Task 4: Full-suite verification and runtime proof

The unit tests prove the state machine; they do not prove the animation reaches a real browser driven by a real daemon rename. This task closes that gap using the isolated-daemon recipe (never point a second daemon at the real `~/.dispatch`).

**Files:**
- Create: `docs/superpowers/verification/2026-07-19-typewriter-label-runtime.md`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: a written verification record.

- [ ] **Step 1: Run both full suites**

```bash
pnpm --filter dispatch-web test
pnpm --filter dispatch-server test
```
Expected: web PASS (524 pre-existing + ~22 new), core PASS (918) — core is untouched, so any core failure means something went wrong.

- [ ] **Step 2: Typecheck and build the bundle**

```bash
pnpm --filter dispatch-web exec tsc -b && pnpm --filter dispatch-web build
```
Expected: clean typecheck, successful vite build.

- [ ] **Step 3: Start an isolated daemon**

```bash
mkdir -p /tmp/tw-home
HOME=/tmp/tw-home PORT=3999 node packages/core/dist/server.js
```
Expected: daemon boots against `/tmp/tw-home/.dispatch`, listening on 3999. Leave it running in a second shell.

- [ ] **Step 4: Prove the animation fires live**

Open `http://localhost:3999`, create a project, and start a Claude thread **without naming it** so it takes the default `Claude Code` label. With the sidebar visible, send it a first prompt and watch the row.

Expected: the label backspaces `Claude Code` away character-by-character with a blinking caret, then types the generated name in. Record the observed name.

- [ ] **Step 5: Prove a reload does NOT animate**

Hard-reload the page with the same thread in view.

Expected: the generated name appears fully formed, no animation, no caret. This is the "only if I'm looking" guarantee — verify it explicitly rather than assuming it.

- [ ] **Step 6: Prove a user rename does not animate**

Rename a thread via the rename dialog.

Expected: instant swap, no typewriter.

- [ ] **Step 7: Write the verification record**

Create `docs/superpowers/verification/2026-07-19-typewriter-label-runtime.md` recording: daemon command and port, the thread's generated name, and a pass/fail line for each of steps 4, 5, and 6 with what was actually observed.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/verification/2026-07-19-typewriter-label-runtime.md
git commit -m "docs: runtime verification for typewriter label"
```

---

## Notes for the reviewer

Three things worth adversarial attention:

1. **Does a reload really never animate?** The guarantee rests entirely on `persist()` (`tabs.ts:64-66`) not persisting `byProject`. If anyone ever adds `byProject` to the persisted keys, a reload rehydrates a stale `labelSource: 'default'`, diffs it against the incoming `'auto'`, and replays an animation for a rename that happened hours ago. Task 2 Step 4(e) carries a comment saying so; confirm it survived.

2. **Accepted behavior, not a bug:** if a thread auto-names while the browser tab is backgrounded and a later `loadTabs` (reconnect, project switch) is the first to observe the change with the row mounted, the animation *will* play at that moment. The user is looking at the list when it fires, which is the intent; the 3000ms window keeps it tied to the observation rather than leaking further.

3. **Caret clipping:** the label span is `nowrap` + ellipsis. During animation the text is shorter than the final label, so the caret is only at risk of clipping for names that already overflow the row. The caret is `width: 0` with a `border-left` specifically so it costs no layout width.
