import { createPortal } from 'react-dom';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CaretDown, CaretRight, Check, ChatsCircle, FunnelSimple, X } from '@phosphor-icons/react';
import type { AccountProvider, Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useAccounts, threadAccount, shortAccountLabel } from '../../stores/accounts';
import { HARNESSES } from '../../lib/harnesses';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Spinner';
import { SwipeRow } from '../common/SwipeRow';
import { SectionHeader } from '../sidebar/sectionParts';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ThreadRow } from '../sidebar/ProjectCard';
import { ThreadMenu, type ThreadMenuAt } from '../sidebar/ThreadMenu';
import { ArchivedThreadsList } from './ArchivedThreadsList';
import { isAgentStarted, startedByOf, startedByText } from '../../lib/startedBy';

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
 * `filterSlot` (the desktop's left panel, 2026-11-07): the Filters button renders there, right of the
 * search, and opens a panel under it instead of a bottom sheet; there are no ACTIVE / ARCHIVED tabs,
 * and the archived threads are a folded ARCHIVED section at the end, as inside a project.
 */
export function AllThreadsView({ onOpenThread, query = '', filterSlot }: { onOpenThread: (projectId: string, tabId: string) => void; query?: string; filterSlot?: HTMLElement | null }) {
  const desktop = filterSlot !== undefined;
  const [archivedOpen, setArchivedOpen] = useState(false);
  const projects = useProjects((s) => s.sessions);
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
  useEffect(() => { try { localStorage.setItem(STARTER_KEY, chosenStarter); } catch { /* ignore */ } }, [chosenStarter]);
  useEffect(() => {
    try {
      if (facets.project) localStorage.setItem(FILTER_KEY, facets.project); else localStorage.removeItem(FILTER_KEY);
      localStorage.setItem(FACETS_KEY, JSON.stringify({ account: facets.account, harness: facets.harness, model: facets.model }));
    } catch { /* ignore */ }
  }, [facets]);
  const setFacet = (id: FacetId, key: string | null) => setFacets((f) => ({ ...f, [id]: key }));

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
  const passes = (t: Terminal, skip?: FacetId) => FACET_IDS.every((id) => id === skip || !active[id] || valueOf[id](t) === active[id]);
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
  // Every active thread that matches the search, newest first: the base for every count and the list.
  const pool = useMemo(() => {
    const all: Terminal[] = [];
    for (const p of projects) for (const t of byProject[p.id] ?? []) if (t.type !== 'file' && !t.archivedAt) all.push(t);
    return all
      .filter((t) => !q || t.label.toLowerCase().includes(q) || (nameOf.get(t.sessionId) ?? '').toLowerCase().includes(q))
      .sort((a, b) => (lastActive(a) < lastActive(b) ? 1 : lastActive(a) > lastActive(b) ? -1 : 0));
  }, [projects, byProject, q, nameOf]);
  const matching = pool.filter((t) => passes(t));
  const nMine = matching.filter(isMine).length;
  const counts: Record<Starter, number> = { mine: nMine, agents: matching.length - nMine, all: matching.length };
  const threads = matching.filter(inStarter);
  const otherFilter: Starter | null = starter === 'mine' ? 'agents' : starter === 'agents' ? 'mine' : null;
  const otherCount = otherFilter ? counts[otherFilter] : 0;
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
  const pickLabel = (id: FacetId) => (active[id] ? optionsFor(id).find((o) => o.key === active[id])?.label ?? active[id] : null);
  // Which filters show: Account only once the accounts are known; on the Archived tab only Project.
  const shownFacets = tab === 'archived' ? (['project'] as FacetId[]) : FACET_IDS.filter((id) => id !== 'account' || !!accountsView);

  async function archive(t: Terminal) {
    try { await api.archiveTerminal(t.id); await useTabs.getState().loadTabs(t.sessionId); } catch { /* surfaced via connection state */ }
  }

  // Active ⇄ Archived (2026-11-05): archived threads were only reachable inside each project.
  const tabBtn = (on: boolean): React.CSSProperties => ({
    padding: '8px 2px 7px', background: 'transparent', border: 'none', cursor: 'pointer', marginBottom: -1,
    borderBottom: on ? '2px solid var(--color-accent)' : '2px solid transparent',
    color: on ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', font: '700 12.5px var(--font-mono)', letterSpacing: '1px',
  });

  // The sheet. While any filter is on, the button says how many and a row of pills says exactly
  // what is applied. Sections start folded, except Started by and any section with a pick.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({ starter: true });
  const isOpen = (id: FacetId | 'starter') => unfolded[id] ?? (id !== 'starter' && !!active[id]);
  const toggle = (id: FacetId | 'starter') => setUnfolded((u) => ({ ...u, [id]: !isOpen(id) }));
  const starterOn = tab === 'active' && anyAgents && starter !== 'all';
  const onFacets = shownFacets.filter((id) => active[id]);
  const nFilters = (starterOn ? 1 : 0) + onFacets.length;
  const starterLabel = STARTERS.find((o) => o.id === starter)?.label;
  const clearAll = () => { setStarter('all'); setFacets({ ...NO_FACETS }); };
  const pill: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 4px 0 10px', flexShrink: 0, maxWidth: 220,
    borderRadius: 'var(--radius-pill)', fontSize: 13, color: 'var(--color-text-primary)',
    background: 'color-mix(in srgb, var(--color-accent) 12%, var(--color-elevated))', border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
  };
  const pillX = (label: string, onClick: () => void) => (
    <button type="button" aria-label={label} onClick={onClick} style={{ display: 'inline-flex', width: 20, height: 20, alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', padding: 0 }}>
      <X size={12} weight="bold" />
    </button>
  );
  const optionRow = (id: FacetId, key: string | null, label: string, note?: string, count?: number) => {
    const on = active[id] === key;
    return (
      <button key={key ?? '__all__'} type="button" aria-pressed={on} aria-label={label} onClick={() => setFacet(id, key)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 40, padding: '0 12px 0 14px', border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 14,
          background: on ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent', color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
        }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {note && <span aria-hidden style={{ fontSize: 12, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{note}</span>}
        {count !== undefined && <span aria-hidden style={{ font: '400 12px var(--font-mono)', color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums', minWidth: 22, textAlign: 'right' }}>{count}</span>}
        <span aria-hidden style={{ width: 16, display: 'inline-flex', justifyContent: 'center', color: 'var(--color-accent)' }}>{on && <Check size={14} weight="bold" />}</span>
      </button>
    );
  };
  const filtersBody = (
        <div data-testid="filters-panel" style={{ display: 'flex', flexDirection: 'column', margin: '0 -4px' }}>
        {tab === 'active' && anyAgents && (
          <Section title="Started by" summary={starter === 'all' ? 'All' : starterLabel} open={isOpen('starter')} onToggle={() => toggle('starter')}>
            <div role="radiogroup" aria-label="Started by" style={{ display: 'flex', gap: 2, padding: 2, margin: '2px 12px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-base)' }}>
              {STARTERS.map((o) => (
                <button key={o.id} type="button" role="radio" aria-checked={starter === o.id} onClick={() => setStarter(o.id)}
                  style={{ flex: 1, height: 30, border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-sm)', fontSize: 13.5, background: starter === o.id ? 'var(--color-hover)' : 'transparent', color: starter === o.id ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>
                  {o.label} <span style={{ color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{counts[o.id]}</span>
                </button>
              ))}
            </div>
          </Section>
        )}
        {shownFacets.map((id) => (
          <Section key={id} title={FACET_TITLE[id]} summary={pickLabel(id) ?? FACET_ALL[id]} open={isOpen(id)} onToggle={() => toggle(id)}>
            <div role="group" aria-label={`${FACET_TITLE[id]} filter`} style={{ display: 'flex', flexDirection: 'column', paddingBottom: 6 }}>
              {optionRow(id, null, FACET_ALL[id])}
              {optionsFor(id).map((o) => optionRow(id, o.key, o.label, o.note, tab === 'active' ? o.count : undefined))}
            </div>
          </Section>
        ))}
        <div style={{ position: 'sticky', bottom: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderTop: '1px solid var(--color-border)', background: 'var(--color-elevated)' }}>
          <button type="button" onClick={clearAll} disabled={!nFilters} style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: 'var(--color-text-secondary)', cursor: 'pointer', opacity: nFilters ? 1 : 0.5 }}>Reset</button>
          <button type="button" onClick={() => setFiltersOpen(false)} style={{ background: 'none', border: 'none', padding: 0, fontSize: 13.5, fontWeight: 500, color: 'var(--color-accent)', cursor: 'pointer' }}>
            {tab === 'active' ? `Show ${threads.length} thread${threads.length === 1 ? '' : 's'}` : 'Done'}
          </button>
        </div>
      </div>
  );
  const filtersButton = (
        <button type="button" aria-expanded={filtersOpen} aria-label={nFilters ? `Filters, ${nFilters} on` : 'Filters'} onClick={() => setFiltersOpen((v) => !v)}
          style={{
            ...(desktop ? { height: 32, padding: '0 9px', borderRadius: 'var(--radius-sm)', background: nFilters || filtersOpen ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-elevated))' : 'var(--color-elevated)' } : { marginLeft: 'auto', alignSelf: 'center', marginBottom: 4, height: 30, padding: '0 10px', borderRadius: 'var(--radius-pill)' }),
            display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, border: `1px solid ${nFilters ? 'color-mix(in srgb, var(--color-accent) 55%, transparent)' : 'var(--color-border)'}`,
            ...(desktop ? {} : { background: nFilters || filtersOpen ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent' }), color: nFilters ? 'var(--color-accent)' : 'var(--color-text-secondary)',
          }}>
          <FunnelSimple size={15} weight="bold" />Filters
          {nFilters > 0 && <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 'var(--radius-pill)', background: 'var(--color-accent)', color: '#06140B', font: '600 11px var(--font-sans)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{nFilters}</span>}
        </button>
  );
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {!desktop && (
      <div role="tablist" aria-label="Thread list" style={{ display: 'flex', gap: 18, padding: '2px 14px 0', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        <button type="button" role="tab" aria-selected={tab === 'active'} onClick={() => setTab('active')} style={tabBtn(tab === 'active')}>ACTIVE</button>
        <button type="button" role="tab" aria-selected={tab === 'archived'} onClick={() => setTab('archived')} style={tabBtn(tab === 'archived')}>ARCHIVED</button>
        {filtersButton}
      </div>
      )}
      {nFilters > 0 && !filtersOpen && (
        <div data-testid="applied-filters" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px 2px', flexWrap: 'wrap', flexShrink: 0 }}>
          {starterOn && <span style={pill}><span style={{ color: 'var(--color-text-secondary)' }}>Started by</span>{starterLabel}{pillX('Remove Started by filter', () => setStarter('all'))}</span>}
          {onFacets.map((id) => (
            <span key={id} style={pill}><span style={{ color: 'var(--color-text-secondary)' }}>{FACET_TITLE[id]}</span><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pickLabel(id)}</span>{pillX(`Remove ${FACET_TITLE[id]} filter`, () => setFacet(id, null))}</span>
          ))}
          <button type="button" onClick={clearAll} style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', fontSize: 12.5, cursor: 'pointer', padding: '0 4px' }}>Clear</button>
        </div>
      )}
      {!desktop && <Modal open={filtersOpen} sheet title="Filters" onClose={() => setFiltersOpen(false)}>{filtersBody}</Modal>}
      {desktop && filterSlot && createPortal(<>
        {filtersButton}
        {filtersOpen && <>
          <div onClick={() => setFiltersOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
          <div role="dialog" aria-label="Filters" data-variant="popover" style={{ position: 'absolute', top: 38, right: 0, zIndex: 91, width: 300, maxHeight: '65vh', overflowY: 'auto', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            {filtersBody}
          </div>
        </>}
      </>, filterSlot)}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '0 4px 12px' }}>
        {tab === 'archived' ? <ArchivedThreadsList project={active.project} query={query} onOpenThread={onOpenThread} /> : <>
        {loading && !threads.length && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>}
        {!loading && !threads.length && (
          <div style={{ padding: '48px 28px', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13.5, lineHeight: 1.6 }}>
            <ChatsCircle size={30} style={{ opacity: 0.5 }} />
            <div style={{ marginTop: 10 }}>{q || onFacets.length || otherCount ? 'No threads match.' : 'No threads yet.'}</div>
            {otherFilter && otherCount > 0 && (
              <button type="button" onClick={() => setStarter(otherFilter)} style={{ marginTop: 12, height: 34, padding: '0 14px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                {otherFilter === 'agents' ? `Show ${otherCount} agent ${otherCount === 1 ? 'thread' : 'threads'}` : `Show ${otherCount} of my threads`}
              </button>
            )}
          </div>
        )}
        {threads.map((t) => (
          // Same row, ⋯ menu and swipe as a project's thread list. The swipe archives
          // straight away: it is undoable from the project's Archived section.
          <SwipeRow key={t.id} disabled={!isMobile} actionLabel="Archive" actionColor="var(--color-status-red)" onAction={() => void archive(t)}>
            <ThreadRow tab={t} active={!isMobile && t.id === activeTabId} subtitle={[active.project ? '' : nameOf.get(t.sessionId) ?? '', startedText(t)].filter(Boolean).join(' · ') || undefined}
              onClick={() => onOpenThread(t.sessionId, t.id)}
              onMiddle={() => onOpenThread(t.sessionId, t.id)}
              onArchive={() => void archive(t)}
              onContext={(x, y) => setMenu({ tab: t, x, y })} />
          </SwipeRow>
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

/** One collapsible filter in the sheet: a header that names the current pick, and the choices under it when open. */
function Section({ title, summary, open, onToggle, children }: { title: string; summary?: string | null; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section style={{ borderBottom: '1px solid var(--color-border)' }}>
      <button type="button" aria-expanded={open} aria-label={`${title}${summary ? `: ${summary}` : ''}`} onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 46, padding: '0 12px 0 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--color-text-primary)', flexShrink: 0 }}>{title}</span>
        <span style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: 13.5, color: summary && !/^All/.test(summary) ? 'var(--color-accent)' : 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <CaretDown size={14} weight="bold" style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }} />
      </button>
      {open && children}
    </section>
  );
}
