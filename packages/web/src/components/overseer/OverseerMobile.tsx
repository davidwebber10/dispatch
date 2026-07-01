// Overseer view — mobile root (spec §1c / §6). Collapses the two desktop regions into
// two tabs (Stream / Work) plus a full-screen drill overlay; "Needs you" now lives in
// the header alert dropdown (NeedsAlert) rather than a third tab. The live working-count
// rides the Work tab title as a pulsing count pill (WorkCountPill) so active work is
// signalled from the tab bar even while the Stream tab is showing. The header and tab
// control are rendered inline here; the tab bodies and the overlay reuse the same shared
// region components as desktop (each adapts its own desktop/mobile rendering via
// useIsMobile — see CONTRACT.md). All data flows through the store / useRenderVals().

import { Icon, StatusDot, overseerRootStyle } from './atoms';
import { useOverseer, useRenderVals } from './store';
import { useDispatchName } from '../../stores/settings';
import './tokens.css';

import { NeedsAlert } from './components/NeedsAlert';
import { ConversationStream } from './components/Stream';
import { Composer } from './components/Composer';
import { OngoingWorkOverview } from './components/WorkRail';
import { ThreadDetail } from './components/ThreadDetail';
import { WorkerLightbox } from './components/WorkerLightbox';

// Pulsing count pill that rides the "Work" tab title — surfaces the live working-agent count
// (the value the old header badge showed) with a breathing accent dot as a subtle "active
// work" flash. Hidden entirely when nothing is working AND nothing is queued so a calm board
// stays calm. When there's also queued (accepted-but-unlaunched) work, a small static/muted
// "· N queued" segment rides alongside it — dimmer than the accent pill so it doesn't compete
// with the pulse. If only queued work exists (no active agents), the pill shows just that
// muted segment on its own, with no leading pulse/active number.
function WorkCountPill({ count, queuedCount }: { count: number; queuedCount: number }) {
  if (count <= 0 && queuedCount <= 0) return null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 6px 1px 5px',
        borderRadius: 999,
        background: 'var(--accDim)',
        border: '1px solid var(--accLine)',
        color: 'var(--acc)',
        fontFamily: 'var(--mono)',
        fontSize: 10.5,
        fontWeight: 700,
        lineHeight: 1.4,
      }}
    >
      {count > 0 && (
        <>
          <StatusDot color="var(--acc)" anim="breathe var(--pulse) ease-in-out infinite" size={5} />
          {count}
        </>
      )}
      {queuedCount > 0 && (
        <span style={{ color: 'var(--tt)', fontWeight: 600 }}>
          {count > 0 ? '· ' : ''}{queuedCount} queued
        </span>
      )}
    </span>
  );
}

export function OverseerMobile({ onBack }: { onBack?: () => void }) {
  const rv = useRenderVals();
  const { ribbon, missions, drillOpen } = rv;
  // Same derivation WorkRail's Queued tab count uses (missions[].queued bucket) — reused here
  // rather than recomputed differently so the tab pill and the rail's own count can't drift.
  const queuedCount = missions.reduce((n, mm) => n + mm.queued.length, 0);
  const name = useDispatchName();
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
      {/* header — single consolidated bar: back ‹ + coordinator name, then the "needs you"
          alert (the separate back-nav bar above was collapsed into this row to reclaim
          vertical space). The live working-count no longer lives here — it moved onto the
          Work tab as a pulsing count pill (see WorkCountPill below), which also leaves
          NeedsAlert as the rightmost header item so its popover anchors cleanly. */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--pane)',
        }}
      >
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Back"
            style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', padding: '2px 0', margin: '-2px 2px -2px 0', color: 'var(--acc)', cursor: 'pointer' }}
          >
            <Icon name="ph-arrow-left" size={20} color="var(--acc)" />
          </button>
        )}
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--tp)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span style={{ flex: 1 }} />
        {/* "Needs you" alert — ⚠ + count; opens the held-items popover (replaces the old
            Needs tab). Kept as the last (rightmost) header item so its popover right-anchors
            cleanly under the ⚠ on mobile. */}
        <NeedsAlert />
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
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            background: activeTab === 'work' ? 'var(--elev)' : 'transparent',
            color: activeTab === 'work' ? 'var(--tp)' : 'var(--ts)',
          }}
        >
          Work
          <WorkCountPill count={ribbon.working} queuedCount={queuedCount} />
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
