import { useEffect, useState } from 'react';
import { useProjects } from '../../stores/projects';
import { ProjectCard } from './ProjectCard';
import { NewProjectModal } from './NewProjectModal';

type Sort = 'recent' | 'alpha' | 'custom';

const SORTS: [Sort, string][] = [['recent', 'Most recent'], ['alpha', 'Alphabetical'], ['custom', 'Custom']];

const icon: React.CSSProperties = { width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, cursor: 'pointer' };

export function ProjectSidebar({ onSelectTab }: { onSelectTab: (terminalId: string) => void }) {
  const sessions = useProjects((s) => s.sessions);
  const activeId = useProjects((s) => s.activeId);
  const setActive = useProjects((s) => s.setActive);
  const [query, setQuery] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [sort, setSort] = useState<Sort>(() => (localStorage.getItem('dispatch:sort') as Sort) || 'recent');
  const [sortOpen, setSortOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  useEffect(() => { try { localStorage.setItem('dispatch:sort', sort); } catch { /* ignore */ } }, [sort]);

  const filtered = sessions
    .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
    .slice()
    .sort((a, b) => {
      if (sort === 'custom') return 0; // preserve the server's stored order
      if (sort === 'alpha') return a.name.localeCompare(b.name);
      return (Date.parse(b.lastActivityAt || b.updatedAt || '') || 0) - (Date.parse(a.lastActivityAt || a.updatedAt || '') || 0);
    });

  // Dragging only makes sense over the unfiltered, full list.
  const canDrag = !query;

  function onDrop(targetId: string) {
    if (dragId && dragId !== targetId) {
      const ids = sessions.map((s) => s.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from !== -1 && to !== -1) {
        const item = ids.splice(from, 1)[0];
        ids.splice(from < to ? to - 1 : to, 0, item); // land just above the indicated card
        if (sort !== 'custom') setSort('custom'); // a manual drag implies a manual order
        useProjects.getState().reorder(ids);
      }
    }
    setDragId(null);
    setOverId(null);
  }

  return (
    <div style={{ padding: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12 }}>
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
      {filtered.map((s) => (
        <div
          key={s.id}
          draggable={canDrag}
          onClick={() => setActive(s.id)}
          onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={(e) => { if (dragId && dragId !== s.id) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overId !== s.id) setOverId(s.id); } }}
          onDragLeave={() => { if (overId === s.id) setOverId(null); }}
          onDrop={(e) => { e.preventDefault(); onDrop(s.id); }}
          onDragEnd={() => { setDragId(null); setOverId(null); }}
          style={{
            borderTop: overId === s.id ? '2px solid var(--color-accent)' : '2px solid transparent',
            opacity: dragId === s.id ? 0.45 : 1,
          }}
        >
          <ProjectCard session={s} active={s.id === activeId} onSelectTab={onSelectTab} />
        </div>
      ))}
      {!filtered.length && <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12.5, padding: '4px 6px' }}>No projects</div>}
      <NewProjectModal open={showNew} onClose={() => setShowNew(false)} />
    </div>
  );
}
