import { useEffect, useState } from 'react';
import { useProjects } from '../../stores/projects';
import { ProjectCard } from './ProjectCard';
import { NewProjectModal } from './NewProjectModal';
import { SortableList } from '../common/SortableList';
import { useIsMobile } from '../../hooks/useIsMobile';

type Sort = 'recent' | 'alpha' | 'custom';

const SORTS: [Sort, string][] = [['recent', 'Most recent'], ['alpha', 'Alphabetical'], ['custom', 'Custom']];

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
      <div className="sidebar-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y' }}>
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
