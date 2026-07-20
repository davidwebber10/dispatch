# Dispatch — Sort control for project card lists

**Date:** 2026-07-20
**Status:** Design approved.

## Goal

Add a sort control beside the existing `+` button in the project card, on both
desktop and mobile, letting the user reorder the Threads list and the Automations
list. The current drag-and-drop arrangement stays available as an explicit
"Custom" option for threads.

## Context in the existing code

- `ProjectCard` renders on **both** desktop (`ProjectSidebar.tsx:148`) and mobile
  (`MobileApp.tsx:260`) — one component, an `isMobile` flag for sizing. A single
  sort button therefore covers both surfaces.
- The header row is `ProjectCard.tsx:401-410`: two `TabPill`s, a `flex: 1`
  spacer, then a `+` button. The `+` is a literal glyph styled by `plusBtn`
  (`:55`) and `plusStyle` (`:245`, 16×16 desktop / 34×34 mobile) — **not** an
  icon component.
- Threads render through `SortableList` (`:411-431`) over `threadItems` (`:260`);
  drag is currently hardcoded `disabled={false}`.
- Automations render as a plain `agents.map()` (`:434`) with **no** drag support.
- There is already a near-identical sort picker one level up, for the *project*
  list: `ProjectSidebar.tsx:124-139` (`⇅` trigger, `SORT BY` mono header, `·`
  selected marker, backdrop for outside-click). This design mirrors it.

## Decisions (confirmed)

1. **Scope:** both tabs — Threads and Automations — each with its own options.
2. **Persistence:** per project, per tab. Not global.
3. **Drag:** stays enabled for threads; dropping flips that project to Custom.
4. **Visibility:** the button hides when the active tab has fewer than 2 items.
5. **"Longest life" dropped** — for a still-running thread it is indistinguishable
   from Oldest, so it added a menu entry without adding an ordering.

## Sort options

### Threads — default `custom`

| Value | Label | Ordering |
|---|---|---|
| `needs` | Needs you first | `status === 'needs_input'` first, then by last activity desc |
| `active` | Recently active | `lastActivityAt` desc |
| `newest` | Newest | `createdAt` desc |
| `oldest` | Oldest | `createdAt` asc |
| `name` | Name (A–Z) | `label` asc, case-insensitive, numeric-aware |
| `custom` | Custom | `sortOrder` asc, tiebroken by `createdAt` asc |

`custom` is the default because it reproduces today's behavior exactly — the
server already returns `ORDER BY sort_order ASC, created_at ASC`
(`packages/core/src/db/terminals.ts:103`). No existing arrangement moves until
the user chooses otherwise.

**The `createdAt` tiebreak in `custom` is required, not decorative.** `sort_order`
is `INTEGER DEFAULT 0` and the INSERT never sets it, so in a project that has
never been drag-reordered *every* row ties at 0. Without a deterministic
tiebreak the rendered order would depend on `Array.prototype.sort` stability
against whatever order the fetch happened to return.

### Automations — default `next`

| Value | Label | Ordering |
|---|---|---|
| `next` | Next run | `nextRunAt` asc, `null` last |
| `updated` | Recently updated | `updatedAt` desc |
| `newest` | Newest | `createdAt` desc |
| `oldest` | Oldest | `createdAt` asc |
| `name` | Name (A–Z) | `name` asc, case-insensitive, numeric-aware |

Automations get **no `custom`** (they have no drag order and no `sortOrder`
field) and **no `needs`** (`AgentSchedule` has no status; `needs_input` belongs to
`AgentRun`). Offering either would require inventing data that does not exist.

`next` is the default because automations have no meaningful current order to
preserve — today's order is an artifact of insertion — and "what fires next" is
the question a list of schedules exists to answer. Disabled schedules have
`nextRunAt === null` and sort last.

## Data notes

From `packages/web/src/api/types.ts` and `packages/core/src/db/terminals.ts:50-70`:

- `createdAt` — always present on both `Terminal` and `AgentSchedule`.
- `lastActivityAt` — optional in the web `Terminal` type for old-daemon safety,
  but the daemon always sends it (coalesced to `created_at`). Comparators use
  `t.lastActivityAt ?? t.createdAt`, matching the existing idiom at
  `ProjectCard.tsx:160`.
- `archivedAt` — **never** a usable sort key here; `listBySession` filters
  `archived_at IS NULL`, so it is always `null` in this list.
- `nextRunAt` — `string | null`; null means disabled/not scheduled.

Any comparator that parses a date must treat an unparseable value as the
oldest/last position rather than producing `NaN`, which would make the
comparator non-transitive and the sort order arbitrary.

## Components

### `stores/listSort.ts` (new)

Holds both maps and persists them under a single localStorage key
`dispatch:listSort`, using the `load`/`save` helpers idiom from
`stores/settings.ts:47-50`.

```ts
export type ThreadSort = 'needs' | 'active' | 'newest' | 'oldest' | 'name' | 'custom';
export type AgentSort = 'next' | 'updated' | 'newest' | 'oldest' | 'name';

interface ListSortState {
  threads: Record<string, ThreadSort>;   // keyed by project id
  agents: Record<string, AgentSort>;
  threadSort: (projectId: string) => ThreadSort;   // returns 'custom' when unset
  agentSort: (projectId: string) => AgentSort;     // returns 'next' when unset
  setThreadSort: (projectId: string, v: ThreadSort) => void;
  setAgentSort: (projectId: string, v: AgentSort) => void;
}
```

Unknown values loaded from storage (an older or hand-edited blob) fall back to
the default rather than being trusted, so a stale key cannot produce an
undefined comparator.

### `lib/listSort.ts` (new)

Pure comparators, no React, unit-tested directly:

```ts
export function sortThreads(items: Terminal[], mode: ThreadSort): Terminal[];
export function sortAgents(items: AgentSchedule[], mode: AgentSort): AgentSchedule[];
```

Both return a **new array** — never sort the caller's array in place — and both
apply a stable final tiebreak on `id` so equal keys cannot reshuffle between
renders.

### `components/sidebar/SortMenu.tsx` (new)

The trigger button plus its menu. Props:

```ts
{
  value: string;
  options: readonly (readonly [string, string])[];  // [value, label]
  onChange: (value: string) => void;
  isMobile: boolean;
}
```

- Trigger inherits `plusStyle` so it matches the `+` at both sizes, uses the `⇅`
  glyph for consistency with the project-list sort, and carries
  `title="Sort"` + `aria-label="Sort"`.
- The menu is rendered with `createPortal` into `document.body` at fixed
  coordinates derived from the trigger's `getBoundingClientRect()`. **This is
  required**: the card's collapse animation uses `grid-template-rows: 0fr` with
  `overflow: hidden` (`ProjectCard.tsx:378-379`), which would clip an
  absolutely-positioned menu. The existing thread context menu
  (`ProjectCard.tsx:454-484`) already uses this portal approach; the visual
  treatment follows it (`#1B1B1E`, `1px solid #2C2C32`, `borderRadius: 9`).
- Closes on selection, on backdrop click, and on `Escape`.
- Menu is right-aligned to the trigger and clamped to the viewport so it cannot
  render off-screen on a narrow mobile viewport.

### `ProjectCard.tsx` (modified)

- Render `<SortMenu>` between the `flex: 1` spacer and the `+` button, so the
  header's existing `gap: 4` spacing applies with no layout change.
- Show it only when the active tab has ≥ 2 items.
- Threads: `threadItems` (`:260`) is passed through `sortThreads(...)` before
  reaching `SortableList`.
- Automations: `agents` (`:218`) is passed through `sortAgents(...)`.
- `SortableList` stays enabled. Its `onReorder` first calls
  `setThreadSort(session.id, 'custom')`, then the existing
  `useTabs.reorder(...)`. Because the persisted order is derived from what the
  user was looking at, dragging out of a sorted view yields a Custom order
  seeded from that view.

## Non-goals

- Sorting the WEB / NOTES / FILES sections.
- Sorting the top tab bar, the Overseer rail, or the project list (which already
  has its own sort).
- A drag order for automations.
- Server-side sorting or any change to `packages/core`.
- Syncing the preference across devices — localStorage only, like every other UI
  preference in this client.

## Testing

**Comparators (`lib/listSort.test.ts`)** — for each mode: correct ordering;
input array not mutated; missing `lastActivityAt` falls back to `createdAt`;
unparseable dates do not produce `NaN` comparisons; `null` `nextRunAt` sorts
last; `custom` with all-zero `sortOrder` falls back to `createdAt` order rather
than arbitrary order; ties broken deterministically by `id`; `name` is
case-insensitive and orders `item2` before `item10`.

**Store (`stores/listSort.test.ts`)** — defaults returned for an unset project
(`custom` / `next`); set-then-read round-trips; the two tabs and two projects are
independent; values persist to `dispatch:listSort`; an unknown persisted value
falls back to the default.

**Component (`SortMenu.test.tsx`)** — menu opens on trigger click; the current
value is marked; choosing an option fires `onChange` and closes; backdrop click
and `Escape` close without firing `onChange`.

**Integration (`ProjectCard` tests)** — the button is absent with 1 thread and
present with 2; choosing "Name (A–Z)" reorders the rendered rows; dragging while
a non-custom sort is active flips the stored mode to `custom`; the Threads and
Automations tabs show different option sets.

**Runtime** — verify in a real browser against an isolated daemon, on both a
desktop and a mobile viewport: the button sits beside the `+` at the right size,
the menu is not clipped by the card, choosing a sort visibly reorders rows, the
choice survives a reload, and it is remembered per project.
