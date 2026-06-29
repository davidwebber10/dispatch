// Overseer view — worker lightbox (spec product refinement, 2026-06-29).
//
// Clicking a managed thread (a thread chip, or a Need's "Open" action) opens this
// modal, which renders that worker's structured chat View — the same surface the
// Operator uses — so the user can monitor at the worker level and interject mid-work.
// Reads workerLightboxId + closeWorkerLightbox from the store; titled from the
// terminal's live label/type. Returns null when nothing is open.

import { ChatView } from '../../tabs/chat/ChatView';
import { findTerminal, useTabs } from '../../../stores/tabs';
import { Icon } from '../atoms';
import { useOverseer } from '../store';

export function WorkerLightbox() {
  const workerLightboxId = useOverseer((s) => s.workerLightboxId);
  const close = useOverseer((s) => s.closeWorkerLightbox);
  const terminal = useTabs((s) => (workerLightboxId ? findTerminal(s.byProject, workerLightboxId) : undefined));

  if (!workerLightboxId) return null;

  const agentType = typeof terminal?.config?.agentType === 'string' ? (terminal.config.agentType as string) : '';
  const mission = typeof terminal?.config?.mission === 'string' ? (terminal.config.mission as string) : '';
  const title = terminal?.label || (agentType ? `${agentType} thread` : 'Worker thread');

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.62)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 60,
      }}
    >
      <div
        style={{
          width: 'min(880px, 96vw)',
          height: 'min(82vh, 900px)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--base)',
          border: '1px solid var(--border)',
          borderRadius: 13,
          overflow: 'hidden',
          boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)',
        }}
      >
        {/* Header */}
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '11px 14px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--pane)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--tp)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {title}
            </span>
            {mission && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)' }}>{mission}</span>
            )}
          </div>
          <button
            onClick={close}
            title="Close"
            style={{
              flex: 'none',
              width: 26,
              height: 26,
              borderRadius: 7,
              background: 'transparent',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ts)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <Icon name="ph-x" size={14} color="var(--ts)" />
          </button>
        </div>

        {/* The structured chat View — monitor + interject */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <ChatView terminalId={workerLightboxId} />
        </div>
      </div>
    </div>
  );
}
