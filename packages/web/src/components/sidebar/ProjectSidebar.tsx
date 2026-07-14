import { useEffect, useRef, useState } from 'react';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { ProjectCard } from './ProjectCard';
import { NewProjectModal } from './NewProjectModal';
import { SortableList } from '../common/SortableList';
import { useIsMobile } from '../../hooks/useIsMobile';
import { revealIn } from '../../lib/reveal';

type Sort = 'recent' | 'alpha' | 'custom';

const SORTS: [Sort, string][] = [['recent', 'Most recent'], ['alpha', 'Alphabetical'], ['custom', 'Custom']];

/* ProjectCard collapses its thread list with a 120ms grid-template-rows transition. A card that
   just opened is still animating, so a row revealed immediately has not reached its final position. */
const EXPAND_SETTLE_MS = 140;

const icon: React.CSSProperties = { width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, cursor: 'pointer' };

export function ProjectSidebar({ onSelectTab, onSelectAgent, onNewAgent, onDispatch }: { onSelectTab: (terminalId: string) => void; onSelectAgent?: (id: string) => void; onNewAgent?: (projectId: string) => void; onDispatch?: (projectId: string) => void }) {
  const sessions = useProjects((s) => s.sessions);
  const activeId = useProjects((s) => s.activeId);
  const [query, setQuery] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem('dispatch:sort') as Sort) || 'recent');
  const [sortOpen, setSortOpen] = useState(false);
  // Expansion is independent of the active highlight: opening a thread makes its
  // project active (and auto-expands it); clicking a project header just toggles
  // its expansion without stealing the highlight.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => { try { localStorage.setItem('dispatch:sort', sort); } catch { /* ignore */ } }, [sort]);
  useEffect(() => { if (activeId) setExpanded((e) => (e.has(activeId) ? e : new Set(e).add(activeId))); }, [activeId]);
  const toggleExpand = (id: string) => setExpanded((e) => { const n = new Set(e); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const isMobile = useIsMobile();

  /* Keep the highlighted row visible.

     Selecting a tab in the top strip moves this sidebar's highlight to that tab's project — but
     with enough projects, the highlighted row sits outside the scroll and the left column looks
     like it simply didn't react.

     Aim at the thread row first: it is the precise thing that got highlighted, and revealing it
     brings its project card along with it. Fall back to the card when the row isn't in the DOM —
     a project fetches its threads asynchronously when it expands, so right after activation the
     row genuinely may not exist yet. `byProject` is in the deps so we re-run once it lands.

     But reveal each selection exactly ONCE. `byProject` is replaced with a new object on every
     terminal:status event, which fires constantly as agents flip working<->idle. Without the guard,
     a user who deliberately scrolled the sidebar elsewhere would get yanked back to the active row
     every few seconds. Scroll when the SELECTION moves; never merely because the store churned. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTabId = useTabs((s) => s.activeTabId);
  const byProject = useTabs((s) => s.byProject);
  // What we last revealed, and whether it was the PRECISE target (the thread row) or merely the
  // project card. A card-only reveal is provisional: the row was not a valid target yet, so we
  // still want to upgrade to it. A precise reveal is final — after that, churn changes nothing.
  const shown = useRef<{ selection: string; precise: boolean } | null>(null);
  /* The settle timer deliberately lives in a ref, NOT in the effect's cleanup.
     Expanding a card makes ProjectCard call loadTabs(), which lands a new `byProject` object within
     a few ms — well inside the settle window. `byProject` is in this effect's deps, so returning a
     clearTimeout cleanup would have React cancel the timer on that re-run, and the `precise` guard
     would then stop it being rescheduled. The corrective pass would silently never fire, leaving the
     row wherever the mid-animation scroll dropped it. (Measured in Chromium: scheduled at +22ms,
     cancelled at +28ms, row left 97px below the fold — permanently.) */
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);   // unmount only

  useEffect(() => {
    const c = scrollRef.current;
    if (!c) return;
    const selection = `${activeId ?? ''}|${activeTabId ?? ''}`;
    const last = shown.current;
    if (last?.selection === selection && last.precise) return;     // nothing better left to show

    /* A COLLAPSED card still has all of its thread rows in the DOM — the collapse is
       `grid-template-rows: 0fr` + overflow:hidden, not a conditional render. So querySelector will
       happily find a row that is clipped to zero height and invisible, and scrolling to it lands
       nowhere useful. The row is only a valid target once its card is actually open. Until then,
       reveal the card; the auto-expand effect above will re-run us with `expanded` updated. */
    const cardOpen = !!activeId && expanded.has(activeId);

    if (cardOpen && activeTabId && revealIn(c, `[data-thread-id="${activeTabId}"]`)) {
      shown.current = { selection, precise: true };
      /* The card may have opened in THIS very commit, so its 120ms transition is still running and
         the row has not reached its final position. Correct it once the animation settles;
         'nearest' makes this a no-op whenever the first pass already landed right. */
      if (settle.current) clearTimeout(settle.current);
      settle.current = setTimeout(() => {
        /* A pending settle pass belongs to the selection that scheduled it. If the user has picked
           something else since, it is stale — firing it would scroll them BACK to a row they just
           navigated away from. (Measured in Chromium: activate A, activate B 50ms later, and A's
           timer dragged the sidebar back to A at +158ms. B can land on the card-only path below,
           which returns without ever reaching the clearTimeout above — so cancelling there is not
           enough; the timer has to check for itself at fire time.) */
        if (shown.current?.selection !== selection) return;
        const el = scrollRef.current;
        if (el) revealIn(el, `[data-thread-id="${activeTabId}"]`);
      }, EXPAND_SETTLE_MS);
      return;
    }

    if (last?.selection === selection) return;   // already showed the card for this selection
    if (activeId && revealIn(c, `[data-project-id="${activeId}"]`)) {
      shown.current = { selection, precise: false };
    }
  }, [activeTabId, activeId, byProject, expanded]);

  const filtered = sessions
    .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
    .slice()
    .sort((a, b) => {
      if (sort === 'custom') return 0; // preserve the server's stored order
      if (sort === 'alpha') return a.name.localeCompare(b.name);
      return (Date.parse(b.lastActivityAt || b.updatedAt || '') || 0) - (Date.parse(a.lastActivityAt || a.updatedAt || '') || 0);
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div ref={scrollRef} className="sidebar-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 2, display: 'flex', gap: 6, alignItems: 'center', padding: '8px 8px 10px', background: 'rgba(22,22,26,0.62)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects"
          style={{ flex: 1, minWidth: 0, height: 32, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)', fontSize: 13 }} />
        <div style={{ position: 'relative' }}>
          <button title="Sort" onClick={() => setSortOpen((o) => !o)} style={{ ...icon, background: 'var(--color-elevated)', border: '1px solid #2C2C32', color: 'var(--color-text-secondary)', fontSize: 14 }}>⇅</button>
          {sortOpen && (
            <>
              <div onClick={() => setSortOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
              <div style={{ position: 'absolute', top: 36, right: 0, zIndex: 91, minWidth: 160, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
                <div style={{ font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', padding: '4px 8px' }}>SORT BY</div>
                {SORTS.map(([v, label]) => (
                  <button key={v} onClick={() => { setSort(v); setSortOpen(false); }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', background: sort === v ? 'var(--color-hover)' : 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 }}>
                    {label}{sort === v ? '  ·' : ''}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button title="New project" onClick={() => setShowNew(true)} style={{ ...icon, background: 'var(--color-accent)', border: 'none', color: '#08240F', font: '700 18px/1 var(--font-sans)' }}>+</button>
      </div>
      <div style={{ padding: '0 8px 8px' }}>
      <SortableList
        items={filtered}
        disabled={!!query || isMobile}
        onReorder={(orderedIds) => { if (sort !== 'custom') setSort('custom'); useProjects.getState().reorder(orderedIds); }}
        renderItem={(s) => (
          <ProjectCard session={s} active={s.id === activeId} open={expanded.has(s.id)} onToggle={() => toggleExpand(s.id)} onSelectTab={onSelectTab} onSelectAgent={onSelectAgent} onNewAgent={onNewAgent} onDispatch={onDispatch} />
        )}
      />
      {!filtered.length && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12.5, padding: '4px 6px' }}>No projects</div>}
      </div>
      </div>
      <NewProjectModal open={showNew} onClose={() => setShowNew(false)} />
    </div>
  );
}
