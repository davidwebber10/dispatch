# Archived-Threads Sidebar Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a quiet, collapsed ARCHIVED section to each project card in the sidebar that lists archived threads and restores them with one click.

**Architecture:** Web-client only. A new `ArchivedSection` component fetches the existing `GET /api/sessions/:id/terminals/archived` endpoint, filters to thread types, and calls the existing `POST /api/terminals/:id/restore` endpoint. `ProjectCard` renders it after the other sections. No daemon changes.

**Tech Stack:** React 18, TypeScript, zustand (`useTabs`), vitest + @testing-library/react, @phosphor-icons/react.

**Spec:** `docs/superpowers/specs/2026-08-25-archived-threads-section-design.md`

## Global Constraints

- Branch: `feat/archived-threads-section`; upstream PR to `davidwebber10/dispatch`.
- Do NOT rebuild or restart the running dispatch daemon. Stop at the PR.
- Expander copy is "Show N more" (the existing `ShowMoreRow` idiom), not "Show all (N)".
- Retry copy is exactly: `Couldn't load archived threads. Retry.` (no em-dash).
- Section cap: `CAP = 10` rows before the expander.
- Filter: keep only `THREAD_TYPES` (from `lib/harnesses.ts`); drop `file` rows.
- Sort: `archivedAt` descending (newest first).
- Test command: `cd packages/web && pnpm vitest run src/components/sidebar`.
- Type gate: `pnpm --filter dispatch-web build` (runs `tsc -b`). Plain `tsc --noEmit` habits from other repos do not apply here.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Extract SectionHeader and ShowMoreRow into sectionParts.tsx

`ProjectCard.tsx` (660 lines) holds two private components the new section needs. Importing them from `ProjectCard` would create an import cycle (ProjectCard → ArchivedSection → ProjectCard), so move them to a shared file. Mechanical move, no behavior change; the existing sidebar tests are the guard.

**Files:**
- Create: `packages/web/src/components/sidebar/sectionParts.tsx`
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx` (delete the two local definitions at lines 204-223 and 626-646; add the import)

**Interfaces:**
- Produces: `export function SectionHeader({ label, count, prominent, children }: { label: string; count: number; prominent?: boolean; children?: React.ReactNode })` and `export function ShowMoreRow({ count, onClick }: { count: number; onClick: () => void })` from `./sectionParts`.

- [ ] **Step 1: Run the existing sidebar tests to establish the green baseline**

Run: `cd packages/web && pnpm vitest run src/components/sidebar`
Expected: PASS (all files).

- [ ] **Step 2: Create sectionParts.tsx with the two components moved verbatim**

```tsx
import { useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import { useIsMobile } from '../../hooks/useIsMobile';

export function SectionHeader({ label, count, prominent, children }: { label: string; count: number; prominent?: boolean; children?: React.ReactNode }) {
  const isMobile = useIsMobile();
  // On mobile all section labels share one bigger, brighter style so FILES
  // matches THREADS / AGENTS; on desktop the prominent/quiet tiers are kept.
  const labelStyle: React.CSSProperties = isMobile
    ? { font: '700 13px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' }
    : prominent
      ? { font: '700 11px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' }
      : { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: isMobile ? '12px 12px 6px' : (prominent ? '4px 6px 3px' : '2px 6px') }}>
      <span style={labelStyle}>{label}</span>
      {prominent && count > 0 && (
        <span style={{ font: `600 ${isMobile ? 11 : 9.5}px var(--font-mono)`, color: 'var(--color-text-secondary)', background: 'var(--color-elevated)', borderRadius: 9, padding: '0 6px', lineHeight: isMobile ? '17px' : '15px' }}>{count}</span>
      )}
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}

export function ShowMoreRow({ count, onClick }: { count: number; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const isMobile = useIsMobile();
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 6, width: '100%',
        padding: isMobile ? '12px' : '4px 9px', background: hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        border: 'none', borderRadius: isMobile ? 0 : 5, textAlign: 'left', cursor: 'pointer',
        color: hover ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
        fontSize: isMobile ? 14 : 11.5,
      }}
    >
      <CaretDown size={isMobile ? 13 : 11} style={{ flexShrink: 0 }} />
      Show {count} more
    </button>
  );
}
```

- [ ] **Step 3: Update ProjectCard.tsx**

Delete the local `SectionHeader` function (lines 204-223) and the local `ShowMoreRow` function (lines 626-646). Add to the import block at the top:

```tsx
import { SectionHeader, ShowMoreRow } from './sectionParts';
```

Do not remove the `CaretDown` import from ProjectCard: it is still used elsewhere in the file (check with grep before deciding; if it becomes unused, remove it so `tsc -b` stays clean).

- [ ] **Step 4: Run the sidebar tests again**

Run: `cd packages/web && pnpm vitest run src/components/sidebar`
Expected: PASS, same set as the baseline.

- [ ] **Step 5: Type-check via the build**

Run: `pnpm --filter dispatch-web build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/sidebar/sectionParts.tsx packages/web/src/components/sidebar/ProjectCard.tsx
git commit -m "refactor(web): extract SectionHeader + ShowMoreRow to sectionParts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ArchivedSection — fetch, filter, sort, cap, expand (happy path + restore)

**Files:**
- Create: `packages/web/src/components/sidebar/ArchivedSection.tsx`
- Test: `packages/web/src/components/sidebar/ArchivedSection.test.tsx`

**Interfaces:**
- Consumes: `SectionHeader`, `ShowMoreRow` from `./sectionParts` (Task 1); `api.listArchivedTerminals(sessionId: string): Promise<Terminal[]>` and `api.restoreTerminal(id: string): Promise<Terminal>` from `../../api/client`; `THREAD_TYPES: TerminalType[]` from `../../lib/harnesses`; `useTabs` from `../../stores/tabs`; `ThreadLabel` from `./ThreadLabel`.
- Produces: `export function ArchivedSection({ sessionId, open, onSelectTab }: { sessionId: string; open: boolean; onSelectTab: (id: string) => void })`. Rows carry `data-archived-id={tab.id}`. The header toggle carries `aria-label="Toggle archived threads"`. Restore buttons carry `aria-label` of `Restore ${tab.label}`.

- [ ] **Step 1: Write the failing tests**

Create `ArchivedSection.test.tsx`:

```tsx
import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ArchivedSection } from './ArchivedSection';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';

const SID = 's1';
function arch(id: string, label: string, archivedAt: string, type = 'claude-code') {
  return { id, sessionId: SID, type, label, status: 'waiting', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: archivedAt, config: {}, archivedAt, sortOrder: 0, externalId: null, pid: null } as any;
}

beforeEach(() => {
  useTabs.setState({ byProject: {}, loading: {}, activeTabId: null } as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderSection(onSelectTab: (id: string) => void = () => {}) {
  render(<ArchivedSection sessionId={SID} open onSelectTab={onSelectTab} />);
}

test('renders nothing when the project has no archived threads', async () => {
  const spy = vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
  renderSection();
  await waitFor(() => expect(spy).toHaveBeenCalledWith(SID));
  expect(screen.queryByText('ARCHIVED')).not.toBeInTheDocument();
});

test('does not fetch while the card is closed', async () => {
  const spy = vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
  render(<ArchivedSection sessionId={SID} open={false} onSelectTab={() => {}} />);
  await new Promise((r) => setTimeout(r, 10));
  expect(spy).not.toHaveBeenCalled();
});

test('file rows are excluded from the list and the count', async () => {
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([
    arch('a1', 'old thread', '2026-08-20T00:00:00.000Z'),
    arch('f1', 'notes.md', '2026-08-21T00:00:00.000Z', 'file'),
  ]);
  renderSection();
  expect(await screen.findByText('ARCHIVED')).toBeInTheDocument();
  expect(screen.getByText('1')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Toggle archived threads'));
  expect(screen.getByText('old thread')).toBeInTheDocument();
  expect(screen.queryByText('notes.md')).not.toBeInTheDocument();
});

test('expands on click, sorts newest first, caps at 10 with Show more', async () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    arch(`a${i + 1}`, `thread ${i + 1}`, `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue(many);
  renderSection();
  expect(await screen.findByText('ARCHIVED')).toBeInTheDocument();
  expect(document.querySelectorAll('[data-archived-id]')).toHaveLength(0); // collapsed by default
  fireEvent.click(screen.getByLabelText('Toggle archived threads'));
  const rows = Array.from(document.querySelectorAll('[data-archived-id]'));
  expect(rows).toHaveLength(10);
  expect(rows[0].getAttribute('data-archived-id')).toBe('a12'); // newest archivedAt first
  fireEvent.click(screen.getByText('Show 2 more'));
  expect(document.querySelectorAll('[data-archived-id]')).toHaveLength(12);
});

test('restore removes the row, reloads tabs, and selects the thread', async () => {
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([arch('a1', 'old thread', '2026-08-20T00:00:00.000Z')]);
  vi.spyOn(api, 'restoreTerminal').mockResolvedValue(arch('a1', 'old thread', '2026-08-20T00:00:00.000Z'));
  const listTerminals = vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
  const onSelect = vi.fn();
  renderSection(onSelect);
  fireEvent.click(await screen.findByLabelText('Toggle archived threads'));
  const row = document.querySelector('[data-archived-id="a1"]') as HTMLElement;
  fireEvent.mouseEnter(row);
  fireEvent.click(screen.getByLabelText('Restore old thread'));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith('a1'));
  expect(api.restoreTerminal).toHaveBeenCalledWith('a1');
  expect(listTerminals).toHaveBeenCalledWith(SID);
  expect(document.querySelector('[data-archived-id="a1"]')).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/web && pnpm vitest run src/components/sidebar/ArchivedSection.test.tsx`
Expected: FAIL — cannot resolve `./ArchivedSection`.

- [ ] **Step 3: Implement ArchivedSection.tsx**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { ArrowCounterClockwise, CaretDown, CaretRight } from '@phosphor-icons/react';
import type { Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { THREAD_TYPES } from '../../lib/harnesses';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ThreadLabel } from './ThreadLabel';
import { SectionHeader, ShowMoreRow } from './sectionParts';

const CAP = 10;

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
}

/**
 * Quiet ARCHIVED section at the bottom of a project card. Archive is a soft
 * delete (the daemon keeps the row + external_id), and restore respawns the
 * agent on its original conversation — this section is the only general UI
 * over that. Hidden entirely when the project has no archived threads.
 */
export function ArchivedSection({ sessionId, open, onSelectTab }: { sessionId: string; open: boolean; onSelectTab: (id: string) => void }) {
  const [rows, setRows] = useState<Terminal[] | null>(null); // null = never loaded
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [restoreFailedId, setRestoreFailedId] = useState<string | null>(null);

  // Refetch key: the LIVE tab-id set for this project. An archive removes an id
  // and a restore adds one, while status flips keep the set identical — so this
  // string changes exactly when the archived list may have changed. loadTabs
  // already runs on every session:tabs-changed broadcast (stores/tabs.ts
  // applyEvent), which the daemon fires on manual archives, the auto-archive
  // loop, and restores — so remote changes land here without new socket wiring.
  const liveIds = useTabs((s) => (s.byProject[sessionId] ?? []).map((t) => t.id).slice().sort().join(','));

  const load = useCallback(async () => {
    try {
      const all = await api.listArchivedTerminals(sessionId);
      setRows(all
        .filter((t) => THREAD_TYPES.includes(t.type))
        .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, liveIds, load]);

  async function restore(t: Terminal) {
    try {
      const restored = await api.restoreTerminal(t.id);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== t.id));
      await useTabs.getState().loadTabs(sessionId);
      onSelectTab(restored.id);
    } catch {
      setRestoreFailedId(t.id);
    }
  }

  // Hidden until we know there is something to show; a failed fetch still
  // renders the header so the retry row is reachable.
  if (!failed && (rows === null || rows.length === 0)) return null;

  const items = rows ?? [];
  const visible = expanded ? (showAll ? items : items.slice(0, CAP)) : [];

  return (
    <div style={{ marginTop: 8 }}>
      <div role="button" aria-label="Toggle archived threads" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }} style={{ cursor: 'pointer' }}>
        <SectionHeader label="ARCHIVED" count={items.length}>
          <span style={{ font: '600 9.5px var(--font-mono)', color: 'var(--color-text-tertiary)', background: 'var(--color-elevated)', borderRadius: 9, padding: '0 6px', lineHeight: '15px' }}>{items.length}</span>
          {expanded
            ? <CaretDown size={11} color="var(--color-text-tertiary)" />
            : <CaretRight size={11} color="var(--color-text-tertiary)" />}
        </SectionHeader>
      </div>
      {expanded && failed && (
        <button onClick={(e) => { e.stopPropagation(); void load(); }}
          style={{ display: 'block', width: '100%', padding: '3px 7px', background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
          Couldn't load archived threads. Retry.
        </button>
      )}
      {visible.map((t) => (
        <ArchivedRow key={t.id} tab={t} failed={restoreFailedId === t.id} onRestore={() => void restore(t)} />
      ))}
      {expanded && !showAll && items.length > CAP && <ShowMoreRow count={items.length - CAP} onClick={() => setShowAll(true)} />}
    </div>
  );
}

function ArchivedRow({ tab, failed, onRestore }: { tab: Terminal; failed: boolean; onRestore: () => void }) {
  const [hover, setHover] = useState(false);
  const isMobile = useIsMobile();
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-archived-id={tab.id}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: isMobile ? '10px 12px' : '3px 7px', borderRadius: isMobile ? 0 : 5, background: hover ? 'rgba(255,255,255,0.04)' : 'transparent' }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: isMobile ? 15 : 12, color: 'var(--color-text-tertiary)' }}>
        <ThreadLabel tab={tab} />
      </span>
      {failed
        ? <span style={{ font: '400 10px var(--font-mono)', color: 'var(--color-status-red)', flexShrink: 0 }}>Restore failed</span>
        : <span style={{ font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{shortDate(tab.archivedAt)}</span>}
      {(hover || isMobile) && (
        <button title="Restore thread" aria-label={`Restore ${tab.label}`}
          onClick={(e) => { e.stopPropagation(); onRestore(); }}
          style={{ width: 16, height: 16, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', borderRadius: 4, flexShrink: 0 }}>
          <ArrowCounterClockwise size={13} weight="bold" />
        </button>
      )}
    </div>
  );
}
```

Note on the restore-failure test in Task 3 and the two failure tests here: `restoreFailedId` and the fetch-failure retry row are part of this file now, but their tests land in Task 3. Implementing them here keeps the file whole; Task 3 only adds tests.

- [ ] **Step 4: Run the Task 2 tests**

Run: `cd packages/web && pnpm vitest run src/components/sidebar/ArchivedSection.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/sidebar/ArchivedSection.tsx packages/web/src/components/sidebar/ArchivedSection.test.tsx
git commit -m "feat(web): ArchivedSection — list + restore archived threads

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Resilience tests — restore failure, fetch retry, live refetch

The implementation shipped in Task 2; this task pins the failure paths and the refetch trigger with tests. If any test fails, fix `ArchivedSection.tsx`, do not weaken the test.

**Files:**
- Modify: `packages/web/src/components/sidebar/ArchivedSection.test.tsx` (append)
- Possibly modify: `packages/web/src/components/sidebar/ArchivedSection.tsx` (only if a test exposes a bug)

**Interfaces:**
- Consumes: everything Task 2 produced, unchanged.

- [ ] **Step 1: Append the failing/verifying tests**

```tsx
test('a failed restore keeps the row and shows an inline error', async () => {
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([arch('a1', 'old thread', '2026-08-20T00:00:00.000Z')]);
  vi.spyOn(api, 'restoreTerminal').mockRejectedValue(new Error('nope'));
  renderSection();
  fireEvent.click(await screen.findByLabelText('Toggle archived threads'));
  const row = document.querySelector('[data-archived-id="a1"]') as HTMLElement;
  fireEvent.mouseEnter(row);
  fireEvent.click(screen.getByLabelText('Restore old thread'));
  expect(await screen.findByText('Restore failed')).toBeInTheDocument();
  expect(document.querySelector('[data-archived-id="a1"]')).not.toBeNull();
});

test('a failed fetch shows a retry row that refetches', async () => {
  const spy = vi.spyOn(api, 'listArchivedTerminals')
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValue([arch('a1', 'old thread', '2026-08-20T00:00:00.000Z')]);
  renderSection();
  fireEvent.click(await screen.findByLabelText('Toggle archived threads'));
  fireEvent.click(await screen.findByText("Couldn't load archived threads. Retry."));
  expect(await screen.findByText('old thread')).toBeInTheDocument();
  expect(spy).toHaveBeenCalledTimes(2);
});

test('refetches when the live tab-id set changes', async () => {
  const spy = vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
  renderSection();
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  useTabs.setState({ byProject: { [SID]: [arch('t1', 'live', '2026-08-20T00:00:00.000Z')] }, loading: {} } as any);
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
});
```

- [ ] **Step 2: Run the full ArchivedSection test file**

Run: `cd packages/web && pnpm vitest run src/components/sidebar/ArchivedSection.test.tsx`
Expected: PASS (8 tests). If a failure exposes a real bug, fix the component and re-run.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/sidebar/ArchivedSection.test.tsx packages/web/src/components/sidebar/ArchivedSection.tsx
git commit -m "test(web): pin ArchivedSection failure paths and live refetch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: ProjectCard integration, existing-test guards, build, PR

**Files:**
- Modify: `packages/web/src/components/sidebar/ProjectCard.tsx` (render seam near line 503: `{SECTIONS.slice(1).map(renderSection)}`)
- Create: `packages/web/src/components/sidebar/ProjectCard.archived.test.tsx`
- Modify: `packages/web/src/components/sidebar/ProjectCard.limits.test.tsx`, `ProjectCard.sort.test.tsx`, `ProjectCard.filesSort.test.tsx`, `ProjectCard.threadLabel.test.tsx` (add one mock line to each `beforeEach`)

**Interfaces:**
- Consumes: `ArchivedSection` from `./ArchivedSection` (Task 2). ProjectCard already has `session.id`, `isOpen` (line 262: `const isOpen = open ?? active;`), and `onSelectTab` in scope.

- [ ] **Step 1: Write the failing integration test**

Create `ProjectCard.archived.test.tsx`:

```tsx
import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import { useTabs } from '../../stores/tabs';
import { useListSort } from '../../stores/listSort';
import { useSettings } from '../../stores/settings';
import { api } from '../../api/client';

const SID = 's1';
const session = { id: SID, name: 'Proj', workingDir: '/tmp', status: 'idle', createdAt: '2026-01-01T00:00:00.000Z' } as any;

beforeEach(() => {
  localStorage.clear();
  useListSort.setState({ threads: {}, agents: {} });
  useSettings.setState({ sidebarMaxThreads: 10, sidebarMaxFiles: 10 });
  useTabs.setState({ byProject: {}, loading: {}, activeTabId: null } as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('an open card renders the ARCHIVED section when archived threads exist', async () => {
  vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([
    { id: 'a1', sessionId: SID, type: 'claude-code', label: 'old thread', status: 'waiting', createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-08-20T00:00:00.000Z', config: {}, archivedAt: '2026-08-20T00:00:00.000Z', sortOrder: 0, externalId: null, pid: null } as any,
  ]);
  render(<ProjectCard session={session} active open onSelectTab={() => {}} />);
  expect(await screen.findByText('ARCHIVED')).toBeInTheDocument();
});

test('a closed card does not fetch the archived list', async () => {
  const spy = vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
  render(<ProjectCard session={session} active={false} open={false} onSelectTab={() => {}} />);
  await new Promise((r) => setTimeout(r, 10));
  expect(spy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/web && pnpm vitest run src/components/sidebar/ProjectCard.archived.test.tsx`
Expected: FAIL — 'ARCHIVED' not found (section not rendered yet).

- [ ] **Step 3: Render ArchivedSection in ProjectCard**

In `ProjectCard.tsx`, add the import:

```tsx
import { ArchivedSection } from './ArchivedSection';
```

Directly after the line `{SECTIONS.slice(1).map(renderSection)}` (near line 503), add:

```tsx
<ArchivedSection sessionId={session.id} open={isOpen} onSelectTab={onSelectTab} />
```

- [ ] **Step 4: Guard the existing ProjectCard tests against the new fetch**

Every existing ProjectCard test renders with `open`, so the section now fires a real fetch in jsdom (caught, but noisy and act-unsafe). Add this line to the `beforeEach` of each of the four existing ProjectCard test files, next to the existing `listTerminals` spy:

```tsx
vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([]);
```

- [ ] **Step 5: Run the whole sidebar suite**

Run: `cd packages/web && pnpm vitest run src/components/sidebar`
Expected: PASS, including the two new files.

- [ ] **Step 6: Run the full web test suite and the build**

Run: `pnpm --filter dispatch-web test && pnpm --filter dispatch-web build`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/sidebar/
git commit -m "feat(web): ARCHIVED section in the project sidebar

Archive is a soft delete, but no general UI listed archived threads or
restored them — the only consumer of the archived endpoint was the
Overseer coordinator menu, filtered to coordinator threads. A thread
that auto-archived simply vanished. Adds a quiet collapsed ARCHIVED
section per project card: lazy count-aware fetch, thread-types only,
newest first, capped at 10, one-click restore onto the original
conversation.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Push the branch and open the upstream PR**

```bash
git push -u origin feat/archived-threads-section
```

If the push is rejected for permissions, fork first (`gh repo fork --remote`) and push to the fork instead. Then:

```bash
gh pr create --repo davidwebber10/dispatch \
  --title "Archived-threads section in the project sidebar" \
  --body "$(cat <<'EOF'
## What

Adds a quiet, collapsed ARCHIVED section to each project card in the sidebar. It lists archived threads (newest first, capped at 10 with a Show-more expander) and restores one with a click, resuming the original agent conversation via the existing restore endpoint.

## Why

Archive is a soft delete and POST /api/terminals/:id/restore already resumes the same conversation, but no general UI exposed either. The only consumer of GET /api/sessions/:id/terminals/archived was the Overseer coordinator menu, which filters to coordinator threads. A thread that hit the 12h auto-archive timer vanished with no way back short of curl. (Real data point: one machine had 467 archived claude-code threads, 128 in one project.)

## How

Web-client only; no daemon changes.

- `ArchivedSection.tsx`: lazy fetch keyed on the card being open; filters to THREAD_TYPES (file rows are the delete path); refetches when the project's live tab-id set changes, which piggybacks on the existing session:tabs-changed -> loadTabs flow, so remote archives/restores stay in sync.
- `sectionParts.tsx`: SectionHeader + ShowMoreRow extracted from ProjectCard so both can share them without an import cycle.
- Hidden entirely when a project has nothing archived. Fetch failure renders a retry row rather than a misleading empty state (same rationale as CoordinatorMenu).
- Design spec: docs/superpowers/specs/2026-08-25-archived-threads-section-design.md

## Testing

- 10 new vitest cases (ArchivedSection.test.tsx, ProjectCard.archived.test.tsx): hidden-when-empty, closed-card laziness, file filtering, sort/cap/expander, restore success/failure, fetch retry, live refetch.
- Full dispatch-web suite and build pass.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9: Report the PR URL and CI status. STOP — do not merge, and do not rebuild or restart the running daemon.**

---

## Self-Review Notes

- Spec coverage: placement/quiet header (T2, T4), hidden-when-empty (T2), lazy fetch on card open (T2, T4), file filtering (T2), newest-first sort (T2), cap + expander (T2), restore semantics incl. select (T2), fetch-retry + restore-failure (T2 impl, T3 tests), live refetch via tabs store (T2 impl, T3 test), no daemon changes (all), upstream PR (T4).
- Deviation from spec, intentional: expander copy is "Show N more" (codebase idiom via the reused ShowMoreRow) instead of the spec's "Show all (N)".
- The refetch mechanism realizes the spec's "refetch on session:tabs-changed" indirectly: that broadcast drives `loadTabs`, which changes the observed live tab-id set. No new socket wiring.
