import { useTabs, findTerminal } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';

export function TabBar() {
  const openTabIds = useTabs((s) => s.openTabIds);
  const activeTabId = useTabs((s) => s.activeTabId);
  const byProject = useTabs((s) => s.byProject);
  const sessions = useProjects((s) => s.sessions);
  if (!openTabIds.length) return null;

  return (
    <div style={{ display: 'flex', height: 44, flexShrink: 0, overflowX: 'auto', background: 'var(--color-pane)', borderBottom: '1px solid var(--color-border)' }}>
      {openTabIds.map((id) => {
        const t = findTerminal(byProject, id);
        const proj = sessions.find((s) => s.id === t?.sessionId);
        const active = id === activeTabId;
        return (
          <div
            key={id}
            onClick={() => useTabs.getState().setActiveTab(id)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); useTabs.getState().closeTab(id); } }}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px 0 15px', minWidth: 150, maxWidth: 230, flexShrink: 0, cursor: 'pointer', borderRight: '1px solid var(--color-border)', background: active ? 'var(--color-base)' : 'transparent', borderBottom: active ? '2px solid var(--color-accent)' : '2px solid transparent' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, lineHeight: 1.2 }}>
              <span style={{ fontSize: 12.5, fontWeight: active ? 500 : 400, color: active ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t?.label ?? 'tab'}</span>
              <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{proj?.name ?? ''}</span>
            </div>
            <button onClick={(e) => { e.stopPropagation(); useTabs.getState().closeTab(id); }} title="Close tab" style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '2px 4px', borderRadius: 4, flexShrink: 0 }}>×</button>
          </div>
        );
      })}
    </div>
  );
}
