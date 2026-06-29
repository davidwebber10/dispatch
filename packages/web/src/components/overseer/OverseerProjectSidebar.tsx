// Overseer — left column: a plain project list (no threads). Clicking a project
// opens the Overseer for that project; the project's ephemeral agents then show
// in the Overseer's "Ongoing work" rail (click one there → worker lightbox).
// Themed with the global --color-* tokens to match the regular sidebar.

import { useEffect, useState } from 'react';
import { useProjects } from '../../stores/projects';
import { Icon } from './atoms';

function homePath(p: string): string {
  return (p || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function ProjectRow({ name, path, active, onClick }: { name: string; path: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '9px 11px',
        background: active ? 'var(--color-hover)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        border: 'none', borderRadius: 8,
        color: active ? 'var(--color-text-primary)' : 'var(--color-text-primary)',
        textAlign: 'left', cursor: 'pointer',
      }}
    >
      <Icon name="ph-folder-simple" size={15} weight={active ? 'fill' : 'regular'} color={active ? 'var(--color-accent)' : 'var(--color-text-secondary)'} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: active ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ display: 'block', font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{path}</span>
      </span>
    </button>
  );
}

export function OverseerProjectSidebar({ onSelectProject }: { onSelectProject?: (sessionId: string) => void }) {
  const sessions = useProjects((s) => s.sessions);
  const activeId = useProjects((s) => s.activeId);

  useEffect(() => { if (sessions.length === 0) void useProjects.getState().load(); }, [sessions.length]);

  function selectProject(id: string) {
    useProjects.getState().setActive(id);
    onSelectProject?.(id);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--color-pane)' }}>
      <div style={{ flexShrink: 0, padding: '11px 12px 7px', font: '700 10.5px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-tertiary)' }}>PROJECTS</div>
      <div className="sidebar-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {sessions.length === 0 && (
          <div style={{ padding: '4px 10px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>No projects</div>
        )}
        {sessions.map((s) => (
          <ProjectRow key={s.id} name={s.name} path={homePath(s.workingDir)} active={s.id === activeId} onClick={() => selectProject(s.id)} />
        ))}
      </div>
    </div>
  );
}
