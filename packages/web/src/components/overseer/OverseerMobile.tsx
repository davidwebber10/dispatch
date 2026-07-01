// Overseer view — mobile root (spec §1c / §6). Collapses the two desktop regions into
// two tabs (Stream / Work) plus a full-screen drill overlay; "Needs you" now lives in
// the header alert dropdown (NeedsAlert) rather than a third tab. The header and tab
// control are rendered inline here; the tab bodies and the overlay reuse the same shared
// region components as desktop (each adapts its own desktop/mobile rendering via
// useIsMobile — see CONTRACT.md). All data flows through the store / useRenderVals().

import { StatusDot, overseerRootStyle } from './atoms';
import { useOverseer, useRenderVals } from './store';
import './tokens.css';

import { NeedsAlert } from './components/NeedsAlert';
import { ConversationStream } from './components/Stream';
import { Composer } from './components/Composer';
import { OngoingWorkOverview } from './components/WorkRail';
import { ThreadDetail } from './components/ThreadDetail';
import { WorkerLightbox } from './components/WorkerLightbox';

export function OverseerMobile() {
  const rv = useRenderVals();
  const { ribbon, drillOpen } = rv;
  const mobileTab = useOverseer((s) => s.mobileTab);
  const setMobileTab = useOverseer((s) => s.setMobileTab);
  // "Needs you" is no longer a tab — it moved to the header alert dropdown. The store still
  // defaults mobileTab to 'needs' (and goNeeds can set it), so fold that onto Stream here
  // rather than editing the shared store.
  const activeTab = mobileTab === 'work' ? 'work' : 'stream';

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
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Dispatch</span>
          <span style={{ fontSize: 10, color: 'var(--tt)' }}>{ribbon.moodText}</span>
        </div>
        <span style={{ flex: 1 }} />
        {/* "Needs you" alert — ⚠ + count; opens the held-items popover (replaces the old
            Needs tab). */}
        <NeedsAlert />
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
          onClick={() => setMobileTab('stream')}
          style={{
            ...tabBtnBase,
            background: activeTab === 'stream' ? 'var(--elev)' : 'transparent',
            color: activeTab === 'stream' ? 'var(--tp)' : 'var(--ts)',
          }}
        >
          Stream
        </button>
        <button
          onClick={() => setMobileTab('work')}
          style={{
            ...tabBtnBase,
            background: activeTab === 'work' ? 'var(--elev)' : 'transparent',
            color: activeTab === 'work' ? 'var(--tp)' : 'var(--ts)',
          }}
        >
          Work
        </button>
      </div>

      {/* active tab body (the mobile variant of each component fills height + owns scroll) */}
      {activeTab === 'stream' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ConversationStream />
          <Composer />
        </div>
      )}
      {activeTab === 'work' && <OngoingWorkOverview />}

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

      <WorkerLightbox />
    </div>
  );
}
