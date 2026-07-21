import { Plus } from '@phosphor-icons/react';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useUI } from '../../stores/ui';
import { api } from '../../api/client';
import { modLabel } from '../../lib/hostkeys';

function homeAbbrev(p: string): string {
  return (p || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

const THREAD_TYPES = ['claude-code', 'codex', 'shell'];

export function EmptyWorkspace({ onSelectTab }: { onSelectTab: (id: string) => void }) {
  const activeId = useProjects((s) => s.activeId);
  const project = useProjects((s) => s.sessions.find((x) => x.id === activeId)) ?? null;
  const threadCount = useTabs((s) => (activeId ? (s.byProject[activeId] ?? []).filter((t) => THREAD_TYPES.includes(t.type)).length : 0));

  async function newThread() {
    if (!activeId) return;
    const t = await api.createTerminal(activeId, { type: 'claude-code' });
    await useTabs.getState().loadTabs(activeId);
    useTabs.getState().markLoading(t.id);
    onSelectTab(t.id);
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: 'var(--color-base)' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, padding: 40, textAlign: 'center' }}>
        <div style={{ width: 60, height: 60, borderRadius: 15, background: 'var(--color-pane)', border: '1px solid var(--color-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 30px -14px rgba(0,0,0,.7)' }}>
          <span style={{ font: '600 24px var(--font-mono)', color: 'var(--color-accent)' }}>&gt;_</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, alignItems: 'center' }}>
          <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--color-text-primary)' }}>No thread selected</span>
          <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 340, lineHeight: 1.55 }}>
            {project ? (
              <>Pick a thread, note, file, or web tab from <span style={{ color: '#c9c9cf', fontWeight: 500 }}>{project.name}</span> in the sidebar — or start a new session below.</>
            ) : (
              <>Pick a project from the sidebar to see its threads, notes, and files.</>
            )}
          </span>
        </div>
        {project && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => void newThread()} style={{ height: 36, padding: '0 16px', background: 'var(--color-accent)', border: 'none', borderRadius: 9, display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
              <Plus size={15} weight="bold" color="#08240F" />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#08240F' }}>New Thread</span>
            </button>
            <button onClick={() => useUI.getState().setInspectorTab('files')} style={{ height: 36, padding: '0 16px', background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 9, color: 'var(--color-text-primary)', fontSize: 13, cursor: 'pointer' }}>Open a File</button>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 6, font: '400 11px var(--font-mono)', color: '#46464d' }}>
          <span><span style={{ color: '#6a6a72' }}>{modLabel('N')}</span> new thread</span>
          <span style={{ color: '#2c2c32' }}>·</span>
          <span><span style={{ color: '#6a6a72' }}>{modLabel('P')}</span> quick open</span>
          <span style={{ color: '#2c2c32' }}>·</span>
          <span><span style={{ color: '#6a6a72' }}>{modLabel('K')}</span> commands</span>
        </div>
      </div>
      {project && (
        <div style={{ height: 26, flexShrink: 0, background: 'var(--color-pane)', borderTop: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', font: '400 11px var(--font-mono)', color: '#6a6a72' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{homeAbbrev(project.workingDir)}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#34343a', border: '1px solid #46464d', boxSizing: 'border-box' }} />
            {threadCount} {threadCount === 1 ? 'thread' : 'threads'} · idle
          </span>
        </div>
      )}
    </div>
  );
}
