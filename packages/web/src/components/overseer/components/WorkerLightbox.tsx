// Overseer view — worker lightbox (spec product refinement, 2026-06-29).
//
// Clicking a managed thread (a thread chip, a Need's "Open" action, or a board card) opens
// this modal, which renders that thread on ITS OWN surface — structured threads as the chat
// View, CLI threads as the transcript or the terminal — so the user can monitor at the
// thread level and interject mid-work. Reads workerLightboxId + closeWorkerLightbox from the
// store; titled from the terminal's live label/type. Returns null when nothing is open.
//
// Header is responsive: DESKTOP packs the detail block + per-agent controls + close into
// one row. MOBILE stacks them — the detail block (name/summary/meta) gets a full-width row
// of its own (the single row starved it to an ellipsis), with the actions wrapping onto a
// compact row below.

import { ChatView } from '../../tabs/chat/ChatView';
import { ConversationView } from '../../tabs/ConversationView';
import { TerminalTab } from '../../tabs/TerminalTab';
import { isStructured } from '../../tabs/TabHost';
import { useTabs, findTerminal } from '../../../stores/tabs';
import { useThreadMode } from '../../../stores/threadMode';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { Icon } from '../atoms';
import { AgentDetailHeader } from './AgentDetailHeader';
import { InterruptButton, StopButton, ArchiveButton } from './AutonomyControls';
import { useOverseer } from '../store';

export function WorkerLightbox() {
  const workerLightboxId = useOverseer((s) => s.workerLightboxId);
  const close = useOverseer((s) => s.closeWorkerLightbox);
  const isMobile = useIsMobile();
  // Which surface this thread actually renders as. Hooks must run unconditionally, so
  // resolve before the early return below.
  const tab = useTabs((s) => (workerLightboxId ? findTerminal(s.byProject, workerLightboxId) : undefined));
  const renderMode = useThreadMode((s) => (workerLightboxId ? s.modes[workerLightboxId] : undefined)) ?? 'expert';

  if (!workerLightboxId) return null;

  const closeBtn = (
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
  );

  // Per-agent controls — graceful interrupt, stop, archive. (The Supervised/Auto autonomy dial
  // was dropped: agents run fine without it and it only crowded the header.) Shared verbatim by
  // both header layouts (only one renders at a time).
  const actions = (
    <>
      <InterruptButton terminalId={workerLightboxId} scheme="scoped" />
      <StopButton terminalId={workerLightboxId} scheme="scoped" />
      <ArchiveButton terminalId={workerLightboxId} scheme="scoped" onArchived={close} />
    </>
  );

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
        padding: isMobile ? 12 : 24,
        zIndex: 60,
      }}
    >
      <div
        style={{
          // Mobile fills the padded viewport (a near-fullscreen sheet); desktop is a centered card.
          width: isMobile ? '100%' : 'min(880px, 96vw)',
          height: isMobile ? '100%' : 'min(82vh, 900px)',
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
        {isMobile ? (
          <div
            style={{
              flex: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              // Top padding clears the iOS status bar/notch — the modal card only gets a 12px
              // margin from the outer overlay (WorkerLightbox.tsx:74), which isn't enough on
              // its own, so pad further whenever the safe area is taller than the base 11px.
              padding: 'max(11px, env(safe-area-inset-top)) 13px 11px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--pane)',
            }}
          >
            {/* name (bumped for prominence) + summary + meta, full width; close top-right */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
              <AgentDetailHeader terminalId={workerLightboxId} nameSize={15} />
              {closeBtn}
            </div>
            {/* actions — wrap onto as many rows as needed rather than overflow */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7 }}>
              {actions}
            </div>
          </div>
        ) : (
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
            <AgentDetailHeader terminalId={workerLightboxId} />
            {actions}
            {closeBtn}
          </div>
        )}

        {/* Render the thread on ITS OWN surface, mirroring TabHost. This lightbox was built
            for Overseer agents, which are always structured — so it hard-rendered ChatView.
            The board opens ANY thread through it, including PTY/CLI ones, and a PTY thread
            has no structured session behind ChatView: it would open to an empty chat. */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {!tab || isStructured(tab)
            ? <ChatView terminalId={workerLightboxId} />
            : (renderMode === 'normal'
                ? <ConversationView terminalId={workerLightboxId} />
                : <TerminalTab terminalId={workerLightboxId} />)}
        </div>
      </div>
    </div>
  );
}
