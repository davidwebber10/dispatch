import { useEffect, useState } from 'react';
import { Folders } from '@phosphor-icons/react';
import { useEndless } from '../../stores/endless';
import { EndlessColumn } from './EndlessColumn';
import { ProjectFilter } from './ProjectFilter';
import { ProjectsPanel } from './ProjectsPanel';
import { Modal } from '../common/Modal';

const toolbarButton: React.CSSProperties = {
  height: 32, padding: '0 10px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, borderRadius: 8,
  border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 12.5,
};

/** The Chat page (spec 2026-10-13, section 7). Loads the tail, the turn state and the projects once. */
export function ChatMode({ mobile = false }: { mobile?: boolean }) {
  const [panel, setPanel] = useState(!mobile);
  const unavailable = useEndless((s) => s.unavailable);
  useEffect(() => {
    const s = useEndless.getState();
    void s.loadTail().catch(() => {});
    void s.refreshState().catch(() => {});
    void s.loadProjects().catch(() => {});
  }, []);
  return (
    <div data-testid="chat-mode" data-mobile={mobile ? '1' : undefined}
      style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0, height: '100%', background: 'var(--color-base)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
        <div data-testid="chat-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexShrink: 0, borderBottom: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
          <div style={{ flex: 1 }} />
          <button type="button" aria-pressed={panel} onClick={() => setPanel((p) => !p)} style={toolbarButton}><Folders size={15} /> Projects</button>
        </div>
        {unavailable && (
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', color: 'var(--color-text-secondary)', fontSize: 13, borderBottom: '1px solid var(--color-border)' }}>
            <span style={{ flex: 1 }}>Chat is unavailable. It may still be starting.</span>
            <button type="button" onClick={() => void useEndless.getState().loadTail().catch(() => {})}
              style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', cursor: 'pointer' }}>Try again</button>
          </div>
        )}
        <ProjectFilter />
        <EndlessColumn />
      </div>
      {panel && !mobile && (
        <aside style={{ width: 280, flexShrink: 0, overflowY: 'auto', borderLeft: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
          <ProjectsPanel />
        </aside>
      )}
      {mobile && <Modal open={panel} onClose={() => setPanel(false)} title="Projects" sheet><ProjectsPanel /></Modal>}
    </div>
  );
}
