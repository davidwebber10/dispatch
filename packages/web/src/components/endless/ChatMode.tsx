import { useEffect, useState } from 'react';
import { Brain, Folders } from '@phosphor-icons/react';
import { useEndless } from '../../stores/endless';
import { EndlessColumn } from './EndlessColumn';
import { ProjectsPanel } from './ProjectsPanel';
import { MemorySearch } from './MemorySearch';
import { MemoryInspector } from './MemoryInspector';
import { DocViewer } from './DocViewer';
import { useDocViewer } from '../../stores/docViewer';
import { Modal } from '../common/Modal';
import { WorkerLightbox } from '../overseer/components/WorkerLightbox';
import { useOverseer } from '../overseer/store';
import { useTabs, findTerminal } from '../../stores/tabs';
import { useUI } from '../../stores/ui';
import '../overseer/tokens.css';

const toolbarButton: React.CSSProperties = {
  height: 32, padding: '0 10px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, borderRadius: 8,
  border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 12.5,
};

/**
 * The lightbox's Open in Threads: close the lightbox and open the thread in the Threads view. A
 * terminal the tabs have not loaded yet opens with the project from its pane row; with no known
 * project, nothing opens.
 */
export function openInThreads(id: string): void {
  const sessionId = findTerminal(useTabs.getState().byProject, id)?.sessionId ?? useEndless.getState().threads.find((t) => t.id === id)?.project;
  useOverseer.getState().closeWorkerLightbox();
  if (!sessionId) return;
  useUI.getState().requestOpenThread({ sessionId, terminalId: id });
  useUI.getState().setView('workspace'); // the "Threads" view; `workspace` is its code name
}

/** The Chat page (spec 2026-10-13, section 7). Loads the tail, the turn state and the projects once. */
export function ChatMode({ mobile = false }: { mobile?: boolean }) {
  const [panel, setPanel] = useState(!mobile);
  const [inspector, setInspector] = useState(false);
  const unavailable = useEndless((s) => s.unavailable);
  const needs = useEndless((s) => s.projects.reduce((n, p) => n + p.needsYou, 0));
  useEffect(() => {
    const s = useEndless.getState();
    void s.loadTail().catch(() => {});
    void s.refreshState().catch(() => {});
    void s.loadProjects().catch(() => {});
    s.watch();
    return () => { useEndless.getState().unwatch(); useOverseer.getState().closeWorkerLightbox(); useDocViewer.getState().close(); };
  }, []);
  return (
    <div data-testid="chat-mode" data-mobile={mobile ? '1' : undefined}
      style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0, height: '100%', background: 'var(--color-base)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
        <div data-testid="chat-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: mobile ? '8px 16px' : '8px 12px', flexWrap: mobile ? 'wrap' : undefined, flexShrink: 0, borderBottom: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
          <MemorySearch />
          <button type="button" onClick={() => setInspector(true)} style={toolbarButton}><Brain size={15} /> Memory</button>
          <button type="button" aria-pressed={panel} aria-label={needs > 0 ? `Projects, ${needs} need${needs === 1 ? 's' : ''} you` : undefined} onClick={() => setPanel((p) => !p)} style={toolbarButton}>
            <Folders size={15} /> Projects
            {needs > 0 && <span aria-hidden style={{ minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: 'var(--color-status-yellow)', color: 'var(--color-canvas)', font: '600 10.5px/16px var(--font-mono)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{needs}</span>}
          </button>
        </div>
        {unavailable && (
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: mobile ? '8px 16px' : '8px 12px', color: 'var(--color-text-secondary)', fontSize: 13, borderBottom: '1px solid var(--color-border)' }}>
            <span style={{ flex: 1 }}>Chat is unavailable. It may still be starting.</span>
            <button type="button" onClick={() => void useEndless.getState().loadTail().catch(() => {})}
              style={{ padding: '5px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', cursor: 'pointer' }}>Try again</button>
          </div>
        )}
        <EndlessColumn mobile={mobile} />
      </div>
      {panel && !mobile && (
        <aside style={{ width: 280, flexShrink: 0, overflowY: 'auto', borderLeft: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
          <ProjectsPanel />
        </aside>
      )}
      {mobile && <Modal open={panel} onClose={() => setPanel(false)} title="Projects" sheet><ProjectsPanel onNavigate={() => setPanel(false)} /></Modal>}
      <MemoryInspector open={inspector} onClose={() => setInspector(false)} sheet={mobile} />
      <div className="overseer-root">
        <WorkerLightbox onOpenFull={openInThreads} />
      </div>
      {/* After the lightbox: a doc opened from a thread stacks above it (Modal z-index 100, the lightbox 60). */}
      <DocViewer />
    </div>
  );
}
