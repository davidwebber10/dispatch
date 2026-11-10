import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretDown, CaretRight, ChatsCircle } from '@phosphor-icons/react';
import type { AccountProvider, Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useAccounts, threadAccount, shortAccountLabel } from '../../stores/accounts';
import { HARNESSES } from '../../lib/harnesses';
import { FilterBar, type FilterFacet } from '../common/FilterBar';
import { Spinner } from '../common/Spinner';
import { SwipeRow } from '../common/SwipeRow';
import { SectionHeader } from '../sidebar/sectionParts';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ThreadRow } from '../sidebar/ProjectCard';
import { ThreadMenu, type ThreadMenuAt } from '../sidebar/ThreadMenu';
import { ArchivedThreadsList } from './ArchivedThreadsList';
import { isAgentStarted, startedByOf, startedByText } from '../../lib/startedBy';
import { useMinuteTick } from '../../lib/autoArchive';

const FILTER_KEY = 'dispatch:mobileThreadsProject';
// v2 (2026-11-06): the default became All. The old key mostly held 'mine' written automatically as
// the old default, so it is not carried over.
const STARTER_KEY = 'dispatch:mobileThreadsStarter:v2';
// The account, harness and model picks (2026-11-06), one JSON object.
const FACETS_KEY = 'dispatch:mobileThreadsFacets';
type Starter = 'mine' | 'agents' | 'all';
const STARTERS: { id: Starter; label: string }[] = [{ id: 'mine', label: 'Mine' }, { id: 'agents', label: 'Agents' }, { id: 'all', label: 'All' }];
const readStarter = (): Starter => { try { const v = localStorage.getItem(STARTER_KEY); return v === 'agents' || v === 'mine' ? v : 'all'; } catch { return 'all'; } };
const lastActive = (t: Terminal) => t.lastActivityAt ?? t.createdAt ?? '';
/**
 * Active within (2026-11-09): keep the threads active in the last hour, since local midnight, since
 * Monday 00:00, or since the 1st of the month. Remembered per device.
 */
type Within = 'hour' | 'today' | 'week' | 'month';
const WITHIN: { value: Within; label: string }[] = [
  { value: 'hour', label: 'Last hour' }, { value: 'today', label: 'Today' }, { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' },
];
const WITHIN_KEY = 'dispatch:threadsActiveWithin';
const readWithin = (): Within | null => {
  try { const v = localStorage.getItem(WITHIN_KEY); return WITHIN.some((w) => w.value === v) ? (v as Within) : null; } catch { return null; }
};
/**
 * A thread that works now, or that waits for the owner, is active whatever its last activity stamp
 * says (I9): the stamp of a turn that has run for 70 minutes is 70 minutes old.
 */
export const activeNow = (t: Pick<Terminal, 'status'>): boolean => t.status === 'working' || t.status === 'needs_input';
/** The start of the period, as an ISO string comparable with lastActivityAt. */
export function withinSince(w: Within, now = new Date()): string {
  if (w === 'hour') return new Date(now.getTime() - 3600_000).toISOString();
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  if (w === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  if (w === 'month') d.setDate(1);
  return d.toISOString();
}

/**
 * The Status filter (W2-F, 2026-11-09): the attention queue as a filter. Needs you is a thread that
 * needs input or has an error; Working is a thread at work. Not remembered: a list that opens on
 * "Needs you" tomorrow hides most threads for no reason the reader can see.
 */
type StatusPick = 'needs' | 'working';
const statusOf = (t: Terminal): StatusPick | null => (t.status === 'needs_input' || t.status === 'error' ? 'needs' : t.status === 'working' ? 'working' : null);

/** The list filters besides Started by. Project is the oldest; the other three came 2026-11-06. */
type FacetId = 'project' | 'account' | 'harness' | 'model';
const FACET_IDS: FacetId[] = ['project', 'account', 'harness', 'model'];
type Facets = Record<FacetId, string | null>;
const NO_FACETS: Facets = { project: null, account: null, harness: null, model: null };
const readFacets = (): Facets => {
  const f = { ...NO_FACETS };
  try { f.project = localStorage.getItem(FILTER_KEY); } catch { /* ignore */ }
  try {
    const saved = JSON.parse(localStorage.getItem(FACETS_KEY) ?? '{}') as Partial<Facets>;
    for (const id of ['account', 'harness', 'model'] as const) if (typeof saved[id] === 'string') f[id] = saved[id] as string;
  } catch { /* ignore */ }
  return f;
};
const FACET_TITLE: Record<FacetId, string> = { project: 'Project', account: 'Account', harness: 'Harness', model: 'Model' };
const FACET_ALL: Record<FacetId, string> = { project: 'All projects', account: 'All accounts', harness: 'All harnesses', model: 'All models' };
const PROVIDER_TITLE: Record<AccountProvider, string> = { claude: 'Claude', codex: 'Codex' };
const harnessLabel = (type: string) => HARNESSES.find((h) => h.type === type)?.label ?? type.charAt(0).toUpperCase() + type.slice(1); // 'notes' → 'Notes'
/** A model id ("opus", "gpt-6-astra") → its catalog label and harness, or the raw id. */
const MODEL_LABEL = new Map<string, { label: string; harness: string }>();
for (const h of HARNESSES) for (const m of h.models) if (m.model) MODEL_LABEL.set(m.model, { label: m.label, harness: h.label });
const DEFAULT_MODEL = '__default__';
const modelOf = (t: Terminal) => (typeof t.config?.model === 'string' && t.config.model ? (t.config.model as string) : DEFAULT_MODEL);

interface Option { key: string; label: string; note?: string; count: number }

/**
 * One row of the list, with its swipe (W1-F). Memoized: this view renders on every status event
 * of every thread (it lists all projects), but a row's props are its own terminal (the store keeps
 * that object until THIS thread changes), primitives and stable callbacks, so only the row of the
 * thread that changed renders with it.
 */
const ListThreadRow = memo(function ListThreadRow({ tab, active, subtitle, swipe, onOpen, onArchive, onContext }: {
  tab: Terminal; active: boolean; subtitle?: string; swipe: boolean;
  onOpen: (tab: Terminal) => void; onArchive: (tab: Terminal) => void; onContext: (tab: Terminal, x: number, y: number) => void;
}) {
  return (
    // Same row, ⋯ menu and swipe as a project's thread list. The swipe archives
    // straight away: it is undoable from the project's Archived section.
    <SwipeRow disabled={!swipe} actionLabel="Archive" actionColor="var(--color-status-red)" onAction={() => onArchive(tab)}>
      <ThreadRow tab={tab} active={active} subtitle={subtitle}
        onClick={() => onOpen(tab)}
        onMiddle={() => onOpen(tab)}
        onArchive={() => onArchive(tab)}
        onContext={(x, y) => onContext(tab, x, y)} />
    </SwipeRow>
  );
});

/**
 * The Threads view of the phone's Projects tab (2026-10-28, replaces the Pinned tab): every
 * thread of every project, newest activity first, with filters and the search box from the
 * header. Pinning is gone: the few threads one works on are nearly always the latest ones, and
 * pinning and unpinning was a chore. Tabs for all projects are loaded on mount, as the Pinned tab
 * did, so threads surface for projects this client never opened.
 *
 * Mine · Agents · All (2026-11-05): most rows were started by an agent (Chat, an overseer, another
 * thread, a scheduled role), which buried the owner's own threads. The split comes from the
 * thread's config alone (lib/startedBy.ts). It opens on All and is remembered per device.
 *
 * The filter sheet (2026-11-06): the Filters button opens a bottom sheet with one collapsible
 * section per filter: Started by, Project, Account, Harness, Model. A section's header names the
 * current pick; open, it lists the choices with a count each. The counts are faceted: a choice
 * counts the threads that match the search and every OTHER filter, so a pick never leads to an
 * empty list. The sheet scrolls, so a few dozen projects are fine (a wrapped row of pills was not).
 */
/**
 * `onQueryChange` (the desktop's left panel, 2026-11-07): the view owns the search row, the shared
 * FilterBar with Filters right of the search, which opens a popover instead of a bottom sheet; there
 * are no ACTIVE / ARCHIVED tabs, and the archived threads are a folded ARCHIVED section at the end,
 * as inside a project. On the phone the search is in the app header and the row holds the tabs.
 */
export function AllThreadsView({ onOpenThread, query = '', onQueryChange }: { onOpenThread: (projectId: string, tabId: string) => void; query?: string; onQueryChange?: (query: string) => void }) {
  const desktop = onQueryChange !== undefined;
  const [archivedOpen, setArchivedOpen] = useState(false);
  const projects = useProjects((s) => s.sessions);
  // Every project on purpose (W1-F): this list IS every thread of every project, sorted and
  // counted together. The rows are memoized (ListThreadRow), so a status event renders one row.
  const byProject = useTabs((s) => s.byProject);
  const accountsView = useAccounts((s) => s.view);
  // The swipe to archive is the phone's; on the desktop (the left panel's Threads view) a row is a plain row.
  const isMobile = useIsMobile();
  // On the desktop the open thread is highlighted, as in a project's list.
  const activeTabId = useTabs((st) => st.activeTabId);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [menu, setMenu] = useState<ThreadMenuAt | null>(null);
  const [facets, setFacets] = useState<Facets>(readFacets);
  const [chosenStarter, setStarter] = useState<Starter>(readStarter);
  const [within, setWithin] = useState<Within | null>(readWithin);
  useEffect(() => { try { if (within) localStorage.setItem(WITHIN_KEY, within); else localStorage.removeItem(WITHIN_KEY); } catch { /* private mode */ } }, [within]);
  useEffect(() => { try { localStorage.setItem(STARTER_KEY, chosenStarter); } catch { /* ignore */ } }, [chosenStarter]);
  useEffect(() => {
    try {
      if (facets.project) localStorage.setItem(FILTER_KEY, facets.project); else localStorage.removeItem(FILTER_KEY);
      localStorage.setItem(FACETS_KEY, JSON.stringify({ account: facets.account, harness: facets.harness, model: facets.model }));
    } catch { /* ignore */ }
  }, [facets]);
  const setFacet = (id: FacetId, key: string | null) => setFacets((f) => ({ ...f, [id]: key }));
  const [statusPick, setStatusPick] = useState<StatusPick | null>(null);

  useEffect(() => {
    let alive = true;
    void useAccounts.getState().load();
    Promise.all(projects.map((p) => useTabs.getState().loadTabs(p.id).catch(() => { /* project gone */ })))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // Load once per mount; session:tabs-changed events keep the lists fresh after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameOf = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const accountKeyOf = (t: Terminal) => {
    const a = threadAccount(accountsView, t);
    return a ? `${t.type === 'codex' ? 'codex' : 'claude'}@${a.id}` : null;
  };
  const accountLabelOf = (key: string) => {
    const [provider, id] = key.split('@') as [AccountProvider, string];
    const a = accountsView?.[provider]?.find((x) => x.id === id);
    return { label: a ? shortAccountLabel(a.label) : id, note: PROVIDER_TITLE[provider] ?? provider };
  };
  const accountExists = (key: string) => {
    const [provider, id] = key.split('@') as [AccountProvider, string];
    return !!accountsView?.[provider]?.some((a) => a.id === id);
  };
  const valueOf: Record<FacetId, (t: Terminal) => string | null> = {
    project: (t) => t.sessionId,
    account: accountKeyOf,
    harness: (t) => t.type,
    model: modelOf,
  };
  // A saved pick that no longer exists (a project or account that is gone) falls back to All.
  const active: Facets = {
    project: facets.project && nameOf.has(facets.project) ? facets.project : null,
    account: facets.account && accountExists(facets.account) ? facets.account : null,
    harness: facets.harness,
    model: facets.model,
  };
  // The Archived tab has no Status filter (an archived thread does not wait or work).
  const statusOn = tab === 'active' ? statusPick : null;
  const passes = (t: Terminal, skip?: FacetId | 'status') =>
    (skip === 'status' || !statusOn || statusOf(t) === statusOn) && FACET_IDS.every((id) => id === skip || !active[id] || valueOf[id](t) === active[id]);
  const q = query.trim().toLowerCase();
  const isMine = (t: Terminal) => !isAgentStarted(t.config);
  // Mine · Agents · All is only worth showing when an agent started something (2026-11-06). Counted
  // over every active thread, not the search or project, so it doesn't come and go while typing.
  // Hidden, the list is everything; the saved choice comes back with the first agent thread.
  const anyAgents = useMemo(
    () => projects.some((p) => (byProject[p.id] ?? []).some((t) => t.type !== 'file' && !t.archivedAt && isAgentStarted(t.config))),
    [projects, byProject],
  );
  const starter: Starter = anyAgents ? chosenStarter : 'all';
  const inStarter = (t: Terminal) => starter === 'all' || isMine(t) === (starter === 'mine');
  // Every active thread, and those that match the search, newest first.
  const everyThread = useMemo(() => {
    const all: Terminal[] = [];
    for (const p of projects) for (const t of byProject[p.id] ?? []) if (t.type !== 'file' && !t.archivedAt) all.push(t);
    return all;
  }, [projects, byProject]);
  const searched = useMemo(() => everyThread
    .filter((t) => !q || t.label.toLowerCase().includes(q) || (nameOf.get(t.sessionId) ?? '').toLowerCase().includes(q))
    .sort((a, b) => (lastActive(a) < lastActive(b) ? 1 : lastActive(a) > lastActive(b) ? -1 : 0)), [everyThread, q, nameOf]);
  // The cut-off of Active within moves with the clock (I9): the shared minute tick renders this view
  // once a minute, only while the filter is on. The rows are memoized, so none of them renders for it.
  const minute = useMinuteTick(within !== null);
  // The base for every count and the list. A thread that works now, or waits for the owner, always stays.
  const pool = useMemo(() => {
    if (!within) return searched;
    const since = withinSince(within, new Date());
    return searched.filter((t) => activeNow(t) || lastActive(t) >= since);
    // `minute` is not read: a new value means the cut-off moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, within, minute]);
  const matching = pool.filter((t) => passes(t));
  const nMine = matching.filter(isMine).length;
  const counts: Record<Starter, number> = { mine: nMine, agents: matching.length - nMine, all: matching.length };
  const threads = matching.filter(inStarter);
  const otherFilter: Starter | null = starter === 'mine' ? 'agents' : starter === 'agents' ? 'mine' : null;
  const otherCount = otherFilter ? counts[otherFilter] : 0;
  // The threads that only Active within hides: they pass the search and every other filter. The filter
  // is saved per device, so a list that it empties must say so and offer the way out (I9).
  const withinLabel = WITHIN.find((w) => w.value === within)?.label ?? '';
  const withinHides = within && !threads.length ? searched.filter((t) => passes(t) && inStarter(t)).length : 0;
  const findParent = (sessionId: string) => (id: string) => (byProject[sessionId] ?? []).find((x) => x.id === id) ?? null;
  const startedText = (t: Terminal) => startedByText(startedByOf(t, findParent(t.sessionId)));

  /** The choices of one filter: each value present among the threads that pass every OTHER filter, with its count. */
  const optionsFor = (id: FacetId): Option[] => {
    if (id === 'project' && tab === 'archived') return projects.map((p) => ({ key: p.id, label: p.name, count: 0 }));
    const tally = new Map<string, number>();
    for (const t of pool) if (inStarter(t) && passes(t, id)) { const k = valueOf[id](t); if (k) tally.set(k, (tally.get(k) ?? 0) + 1); }
    if (active[id] && !tally.has(active[id] as string)) tally.set(active[id] as string, 0); // the pressed one always stays
    const describe = (key: string): { label: string; note?: string } => {
      if (id === 'project') return { label: nameOf.get(key) ?? key };
      if (id === 'account') return accountLabelOf(key);
      if (id === 'harness') return { label: harnessLabel(key) };
      if (key === DEFAULT_MODEL) return { label: 'Default' };
      const m = MODEL_LABEL.get(key);
      return m ? { label: m.label, note: m.harness } : { label: key };
    };
    return [...tally].map(([key, count]) => ({ key, count, ...describe(key) }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  // Which filters show: Account only once the accounts are known; on the Archived tab only Project.
  const shownFacets = tab === 'archived' ? (['project'] as FacetId[]) : FACET_IDS.filter((id) => id !== 'account' || !!accountsView);

  // Stable for the memoized rows; onOpenThread is read through a ref, so a new function from the parent is still the one called.
  const archive = useCallback(async (t: Terminal) => {
    await useTabs.getState().archive(t.id); // optimistic (W2-I): the row goes at once; a failure puts it back with a hint
  }, []);
  const openRef = useRef(onOpenThread); openRef.current = onOpenThread;
  const openRow = useCallback((t: Terminal) => openRef.current(t.sessionId, t.id), []);
  const archiveRow = useCallback((t: Terminal) => { void archive(t); }, [archive]);
  const contextRow = useCallback((t: Terminal, x: number, y: number) => setMenu({ tab: t, x, y }), []);

  // Active ⇄ Archived (2026-11-05): archived threads were only reachable inside each project.
  const tabBtn = (on: boolean): React.CSSProperties => ({
    padding: '8px 2px 7px', background: 'transparent', border: 'none', cursor: 'pointer', marginBottom: -1,
    borderBottom: on ? '2px solid var(--color-accent)' : '2px solid transparent',
    color: on ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', font: '700 12.5px var(--font-mono)', letterSpacing: '1px',
  });

  // The filters are the shared FilterBar (2026-11-07): one section per filter, a pill per filter
  // that is on while the panel is closed, Clear. Started by is a segmented switch; it shows only on
  // the Active tab and once an agent started something.
  const starterOn = tab === 'active' && anyAgents;
  // Counted like every other choice: over the threads that pass the search and every OTHER filter.
  const statusCounts = { needs: 0, working: 0, all: 0 };
  for (const t of pool) if (inStarter(t) && passes(t, 'status')) { statusCounts.all++; const st = statusOf(t); if (st) statusCounts[st]++; }
  const filterFacets: FilterFacet[] = [
    ...(tab === 'active' ? [{
      id: 'status', title: 'Status', display: 'segmented' as const, defaultOpen: true, allLabel: 'All', allCount: statusCounts.all,
      value: statusPick,
      options: [{ value: 'needs', label: 'Needs you', count: statusCounts.needs }, { value: 'working', label: 'Working', count: statusCounts.working }],
      onChange: (v: string | null) => setStatusPick(v as StatusPick | null),
    }] : []),
    ...(starterOn ? [{
      id: 'starter', title: 'Started by', display: 'segmented' as const, defaultOpen: true, allLabel: 'All', allCount: counts.all,
      value: starter === 'all' ? null : starter,
      options: STARTERS.filter((o) => o.id !== 'all').map((o) => ({ value: o.id, label: o.label, count: counts[o.id] })),
      onChange: (v: string | null) => setStarter((v ?? 'all') as Starter),
    }] : []),
    ...(tab === 'active' ? [{
      id: 'within', title: 'Active within', defaultOpen: !!within, allLabel: 'Any time',
      value: within,
      options: WITHIN.map((w) => ({ value: w.value, label: w.label })),
      onChange: (v: string | null) => setWithin(WITHIN.some((w) => w.value === v) ? (v as Within) : null),
    }] : []),
    ...shownFacets.map((id) => ({
      id, title: FACET_TITLE[id], allLabel: FACET_ALL[id], value: active[id], defaultOpen: !!active[id],
      options: optionsFor(id).map((o) => ({ value: o.key, label: o.label, note: o.note, count: tab === 'active' ? o.count : undefined })),
      onChange: (v: string | null) => setFacet(id, v),
    })),
  ];
  const onFacets = shownFacets.filter((id) => active[id]);
  const doneLabel = tab === 'active' ? `Show ${threads.length} thread${threads.length === 1 ? '' : 's'}` : 'Done';
  const filterBar = desktop ? (
    <FilterBar variant="popover" size="md" facets={filterFacets} doneLabel={doneLabel} query={query} onQueryChange={onQueryChange} placeholder="Search threads" rowTestId="sidebar-search-row"
      style={{ padding: '8px 8px 10px', gap: 8, background: 'color-mix(in srgb, var(--color-pane) 62%, transparent)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', borderBottom: '1px solid color-mix(in srgb, var(--color-text-emphasis) 6%, transparent)' }} />
  ) : (
    <FilterBar variant="sheet" size="md" facets={filterFacets} doneLabel={doneLabel} style={{ gap: 0 }}
      rowStyle={{ padding: '2px 14px 0', borderBottom: '1px solid var(--color-border)' }} pillsStyle={{ padding: '8px 12px 2px' }}
      leading={(
        <div role="tablist" aria-label="Thread list" style={{ flex: 1, display: 'flex', gap: 18, alignSelf: 'stretch', alignItems: 'flex-end' }}>
          <button type="button" role="tab" aria-selected={tab === 'active'} onClick={() => setTab('active')} style={tabBtn(tab === 'active')}>ACTIVE</button>
          <button type="button" role="tab" aria-selected={tab === 'archived'} onClick={() => setTab('archived')} style={tabBtn(tab === 'archived')}>ARCHIVED</button>
        </div>
      )} />
  );
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {filterBar}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '0 4px 12px' }}>
        {tab === 'archived' ? <ArchivedThreadsList project={active.project} query={query} onOpenThread={onOpenThread} /> : <>
        {loading && !threads.length && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>}
        {!loading && !threads.length && (
          <div style={{ padding: '48px 28px', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13.5, lineHeight: 1.6 }}>
            <ChatsCircle size={30} style={{ opacity: 0.5 }} />
            <div style={{ marginTop: 10 }}>
              {withinHides > 0 ? `The filter "Active within: ${withinLabel}" hides ${withinHides} ${withinHides === 1 ? 'thread' : 'threads'}.`
                : everyThread.length ? 'No threads match.' : 'No threads yet.'}
            </div>
            {withinHides > 0 && (
              <button type="button" onClick={() => setWithin(null)} style={{ marginTop: 12, height: 34, padding: '0 14px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                Clear the filter
              </button>
            )}
            {otherFilter && otherCount > 0 && (
              <button type="button" onClick={() => setStarter(otherFilter)} style={{ marginTop: 12, height: 34, padding: '0 14px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                {otherFilter === 'agents' ? `Show ${otherCount} agent ${otherCount === 1 ? 'thread' : 'threads'}` : `Show ${otherCount} of my threads`}
              </button>
            )}
          </div>
        )}
        {threads.map((t) => (
          <ListThreadRow key={t.id} tab={t} active={!isMobile && t.id === activeTabId} swipe={isMobile}
            subtitle={[active.project ? '' : nameOf.get(t.sessionId) ?? '', startedText(t)].filter(Boolean).join(' · ') || undefined}
            onOpen={openRow} onArchive={archiveRow} onContext={contextRow} />
        ))}
        {desktop && (
          <div style={{ marginTop: 8 }}>
            <div role="button" aria-label="Toggle archived threads" aria-expanded={archivedOpen} onClick={() => setArchivedOpen((v) => !v)} style={{ cursor: 'pointer' }}>
              <SectionHeader label="ARCHIVED" count={0}>
                {archivedOpen ? <CaretDown size={11} color="var(--color-text-tertiary)" /> : <CaretRight size={11} color="var(--color-text-tertiary)" />}
              </SectionHeader>
            </div>
            {archivedOpen && <ArchivedThreadsList project={active.project} query={query} onOpenThread={onOpenThread} />}
          </div>
        )}
        </>}
      </div>
      <ThreadMenu at={menu} onClose={() => setMenu(null)} onBranched={(b) => onOpenThread(b.sessionId, b.id)} />
    </div>
  );
}
