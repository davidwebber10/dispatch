import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEndless } from '../../stores/endless';
import { EndlessColumn } from './EndlessColumn';
import { ChatHeader } from './ChatHeader';
import { ChatThreadsList } from './ChatThreads';
import { ProjectsPanel } from './ProjectsPanel';
import { MemoryInspector } from './MemoryInspector';
import { DocViewer } from './DocViewer';
import { ThreadDocsContext, useThreadDocChips } from '../threadDocs';
import { useDocViewer } from '../../stores/docViewer';
import { Modal } from '../common/Modal';
import { WorkerLightbox } from '../overseer/components/WorkerLightbox';
import { useOverseer } from '../overseer/store';
import { useTabs, findTerminal } from '../../stores/tabs';
import { useUI } from '../../stores/ui';
import '../overseer/tokens.css';
import { fontVar } from '../../lib/fontSize';

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
export function ChatMode({ mobile = false, toolbarHost }: {
  mobile?: boolean;
  /** Where the header row goes: a slot of the phone's app header. Undefined: at the top of this view. Null: that slot is not on screen. */
  toolbarHost?: HTMLElement | null;
}) {
  const [panel, setPanel] = useState(!mobile);
  const [inspector, setInspector] = useState(false);
  const [projects, setProjects] = useState(false);
  const unavailable = useEndless((s) => s.unavailable);
  useEffect(() => {
    const s = useEndless.getState();
    void s.loadTail().catch(() => {});
    void s.refreshState().catch(() => {});
    void s.loadProjects().catch(() => {});
    s.watch();
    return () => { useEndless.getState().unwatch(); useOverseer.getState().closeWorkerLightbox(); useDocViewer.getState().close(); };
  }, []);
  // Doc links in any Chat text (a live reply, a note card) open in Chat's own viewer below.
  const docs = useThreadDocChips(null, undefined);
  const header = <ChatHeader threadsOpen={panel} onThreads={() => setPanel((p) => !p)} onMemory={() => setInspector(true)} onProjects={() => setProjects(true)} />;
  return (
    <ThreadDocsContext.Provider value={docs}>
    <div data-testid="chat-mode" data-mobile={mobile ? '1' : undefined}
      style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0, height: '100%', background: 'var(--color-base)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
        {toolbarHost === undefined ? (
          <div data-testid="chat-toolbar" style={{ display: 'flex', alignItems: 'center', minHeight: 52, padding: '0 12px', flexShrink: 0, borderBottom: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>{header}</div>
        ) : toolbarHost && createPortal(header, toolbarHost)}
        {unavailable && (
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: mobile ? '8px 16px' : '8px 12px', color: 'var(--color-text-secondary)', fontSize: fontVar(13), borderBottom: '1px solid var(--color-border)' }}>
            <span style={{ flex: 1 }}>Chat is unavailable. It may still be starting.</span>
            <button type="button" onClick={() => void useEndless.getState().loadTail().catch(() => {})}
              style={{ padding: '5px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', cursor: 'pointer' }}>Try again</button>
          </div>
        )}
        <EndlessColumn mobile={mobile} onShowThreads={() => setPanel(true)} threadsShown={!mobile && panel} />
      </div>
      {panel && !mobile && (
        <aside aria-label="Threads" style={{ width: 280, flexShrink: 0, overflowY: 'auto', boxSizing: 'border-box', padding: 12, borderLeft: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
          <h2 style={{ margin: '0 0 8px', fontSize: fontVar(15), fontWeight: 600, color: 'var(--color-text-primary)' }}>Threads</h2>
          <ChatThreadsList />
        </aside>
      )}
      {mobile && <Modal open={panel} onClose={() => setPanel(false)} title="Threads" sheet><ChatThreadsList onNavigate={() => setPanel(false)} /></Modal>}
      {/* Projects left the header; its panel (counts, documents, threads that need you) opens from the ⋯ menu. */}
      <Modal open={projects} onClose={() => setProjects(false)} title="Projects" sheet maxWidth={460}><ProjectsPanel hideTitle onNavigate={() => setProjects(false)} /></Modal>
      <MemoryInspector open={inspector} onClose={() => setInspector(false)} sheet={mobile} />
      <div className="overseer-root">
        <WorkerLightbox onOpenFull={openInThreads} />
      </div>
      {/* After the lightbox: a doc opened from a thread stacks above it (Modal z-index 100, the lightbox 60). */}
      <DocViewer />
    </div>
    </ThreadDocsContext.Provider>
  );
}
