// Overseer view — mobile root (spec §1c / §6). Collapses the two desktop regions into
// three tabs (Needs / Stream / Work) plus a full-screen drill overlay. The header and
// tab control are rendered inline here; the tab bodies and the overlay reuse the same
// shared region components as desktop (each adapts its own desktop/mobile rendering via
// useIsMobile — see CONTRACT.md). All data flows through the store / useRenderVals().

import { Icon, StatusDot, overseerRootStyle } from './atoms';
import { useOverseer, useRenderVals } from './store';
import './tokens.css';

import { NeedsZone } from './components/NeedsZone';
import { ConversationStream } from './components/Stream';
import { Composer } from './components/Composer';
import { OngoingWorkOverview } from './components/WorkRail';
import { ThreadDetail } from './components/ThreadDetail';
import { DelegateModal } from './components/DelegateModal';
import { WorkerLightbox } from './components/WorkerLightbox';

export function OverseerMobile() {
  const rv = useRenderVals();
  const { ribbon, drillOpen } = rv;
  const mobileTab = useOverseer((s) => s.mobileTab);
  const setMobileTab = useOverseer((s) => s.setMobileTab);
  const delegateOpen = useOverseer((s) => s.delegateOpen);

  const tabBtnBase = {
    flex: 1,
    padding: '8px 0',
    borderRadius: 8,
    border: 'none',
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  } as const;

  return (
    <div className="overseer-root" style={{ ...overseerRootStyle, position: 'relative', overflow: 'hidden' }}>
      {/* header */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '9px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--pane)',
        }}
      >
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: 7,
            background: 'linear-gradient(150deg,#1b3a26,#0f1f16)',
            border: '1px solid var(--accLine)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--acc)',
          }}
        >
          <Icon name="ph-broadcast" weight="fill" size={13} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Overseer</span>
          <span style={{ fontSize: 10, color: 'var(--tt)' }}>{ribbon.moodText}</span>
        </div>
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 9px',
            borderRadius: 7,
            background: 'var(--elev)',
            border: '1px solid var(--border)',
            fontSize: 11,
            color: 'var(--ts)',
          }}
        >
          <StatusDot color="var(--acc)" anim="breathe var(--pulse) ease-in-out infinite" size={5} />
          {ribbon.working}
        </span>
      </div>

      {/* tabs */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          gap: 4,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--pane)',
        }}
      >
        <button
          onClick={() => setMobileTab('needs')}
          style={{
            ...tabBtnBase,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            background: mobileTab === 'needs' ? 'var(--elev)' : 'transparent',
            color: mobileTab === 'needs' ? 'var(--yellow)' : 'var(--ts)',
          }}
        >
          <Icon name="ph-warning" weight="fill" size={13} />
          Needs you
          {ribbon.hasNeeds && (
            <span
              style={{
                background: 'var(--yellow)',
                color: '#1a1400',
                borderRadius: 9,
                fontSize: 9.5,
                fontWeight: 700,
                padding: '1px 6px',
                fontFamily: 'var(--mono)',
              }}
            >
              {ribbon.needs}
            </span>
          )}
        </button>
        <button
          onClick={() => setMobileTab('stream')}
          style={{
            ...tabBtnBase,
            background: mobileTab === 'stream' ? 'var(--elev)' : 'transparent',
            color: mobileTab === 'stream' ? 'var(--tp)' : 'var(--ts)',
          }}
        >
          Stream
        </button>
        <button
          onClick={() => setMobileTab('work')}
          style={{
            ...tabBtnBase,
            background: mobileTab === 'work' ? 'var(--elev)' : 'transparent',
            color: mobileTab === 'work' ? 'var(--tp)' : 'var(--ts)',
          }}
        >
          Work
        </button>
      </div>

      {/* active tab body (the mobile variant of each component fills height + owns scroll) */}
      {mobileTab === 'needs' && <NeedsZone />}
      {mobileTab === 'stream' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ConversationStream />
          <Composer />
        </div>
      )}
      {mobileTab === 'work' && <OngoingWorkOverview />}

      {/* full-screen drill overlay (spec §1c) — ThreadDetail renders its mobile variant */}
      {drillOpen && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'var(--base)',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 5,
          }}
        >
          <ThreadDetail />
        </div>
      )}

      {delegateOpen && <DelegateModal />}
      <WorkerLightbox />
    </div>
  );
}
