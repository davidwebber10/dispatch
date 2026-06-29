// Overseer view — desktop root (spec §1b). Owns the theme tokens (via .overseer-root
// + overseerRootStyle), composes the shared region components, and swaps to the mobile
// variant at the narrow breakpoint. All data flows through the store / useRenderVals();
// no props are passed to the region components.

import { useIsMobile } from '../../hooks/useIsMobile';
import { overseerRootStyle } from './atoms';
import { OverseerMobile } from './OverseerMobile';
import { useCoordinatorSync, useOverseer, useRenderVals } from './store';
import './tokens.css';

import { OverseerHeader } from './components/Header';
import { NeedsZone } from './components/NeedsZone';
import { ConversationStream } from './components/Stream';
import { Composer } from './components/Composer';
import { OngoingWorkOverview } from './components/WorkRail';
import { ThreadDetail } from './components/ThreadDetail';
import { DelegateModal } from './components/DelegateModal';
import { WorkerLightbox } from './components/WorkerLightbox';

export function OverseerView() {
  const isMobile = useIsMobile();
  // Single owner of the live coordinator subscription (runs for both desktop and
  // mobile since OverseerView is the entry for both).
  useCoordinatorSync();
  const rv = useRenderVals();
  const delegateOpen = useOverseer((s) => s.delegateOpen);

  if (isMobile) return <OverseerMobile />;

  return (
    <div className="overseer-root" style={overseerRootStyle}>
      {/* stage — centers the panel; rounded-card framing is optional chrome (spec §1b) */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          background: 'var(--canvas)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'stretch',
          padding: 18,
        }}
      >
        {/* outer panel */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            maxWidth: 1320,
            margin: '0 auto',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--base)',
            border: '1px solid var(--border)',
            borderRadius: 14,
            overflow: 'hidden',
            boxShadow: '0 24px 70px -28px rgba(0,0,0,.8)',
          }}
        >
          <OverseerHeader />

          {/* body: left conversation column + fixed right rail */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {/* LEFT — conversation membrane */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {rv.hasNeeds && <NeedsZone />}
              <ConversationStream />
              <Composer />
            </div>

            {/* RIGHT — 380px rail: overview OR drill detail */}
            <div
              style={{
                width: 380,
                flex: 'none',
                borderLeft: '1px solid var(--border)',
                background: 'var(--pane)',
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
              }}
            >
              {rv.overviewOpen ? <OngoingWorkOverview /> : <ThreadDetail />}
            </div>
          </div>
        </div>
      </div>

      {delegateOpen && <DelegateModal />}
      <WorkerLightbox />
    </div>
  );
}
