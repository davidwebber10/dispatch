// Overseer view — ongoing-work overview (spec §6 "Work rail — overview").
//
// Renders the right-rail overview (desktop) or the Work tab body (mobile):
//   • RailHeader — "Ongoing work" + Delegate button
//   • MissionGroup per mission — header (dot · name · summary),
//     AgentThreadChip per thread (click → drillInto), OutcomeCard per outcome (dashed)
//   • EmptyMissions state when rv.noMissions
//
// Consumes useRenderVals() (rv.missions, rv.noMissions, rv.emptyMode) and
// useOverseer (openDelegate, drillInto). Mobile: "Delegate a task" button on top,
// simpler empty text. Inline styles only — no Tailwind classes.

import { useState } from 'react';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { Icon, MonoLabel, ProgressBar, StatusDot, TypeIconBox } from '../atoms';
import { useOverseer, useRenderVals } from '../store';
import type { AgentThread, Mission, Outcome } from '../types';

// ---------------------------------------------------------------------------
// AgentThreadChip
// ---------------------------------------------------------------------------

function AgentThreadChip({ thread }: { thread: AgentThread }) {
  const drillInto = useOverseer((s) => s.drillInto);
  const [hovered, setHovered] = useState(false);

  return (
    <div
      data-key={thread.key}
      data-label={thread.dlabel}
      onClick={() => drillInto(thread.key, thread.dlabel)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        gap: 10,
        padding: '11px 12px',
        background: hovered ? 'var(--hover)' : 'var(--elev)',
        border: `1px solid ${hovered ? '#36363c' : 'var(--border)'}`,
        borderRadius: 9,
        cursor: 'pointer',
        transition: 'background 0.12s, border-color 0.12s',
      }}
    >
      {/* type icon box */}
      <TypeIconBox icon={thread.typeIcon} size={28} />

      {/* body */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {/* row 1: typeLabel · #id + status */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10.5,
              color: 'var(--ts)',
            }}
          >
            {thread.typeLabel} · #{thread.id}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <StatusDot color={thread.dotColor} anim={thread.dotAnim} size={6} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ts)' }}>
              {thread.statusLabel}
            </span>
          </span>
        </div>

        {/* row 2: action line */}
        <div
          style={{
            fontSize: 13,
            color: 'var(--tp)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {thread.action}
        </div>

        {/* row 3: progress bar + elapsed (working only) */}
        {thread.showProgress && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ProgressBar width={thread.progressW} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)', flex: 'none' }}>
              {thread.elapsed}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OutcomeCard
// ---------------------------------------------------------------------------

function OutcomeCard({ outcome }: { outcome: Outcome }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '9px 12px',
        border: '1px dashed var(--border)',
        borderRadius: 9,
        alignItems: 'flex-start',
      }}
    >
      {/* seal-check icon box */}
      <div
        style={{
          flex: 'none',
          width: 24,
          height: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="ph-seal-check" weight="fill" size={15} color="var(--acc)" />
      </div>

      {/* text */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span
          style={{
            fontSize: 12.5,
            color: 'var(--ts)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {outcome.title}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--tt)' }}>
          {outcome.typeLabel} #{outcome.id} · {outcome.meta}
        </span>
      </div>

      {/* link arrow */}
      <Icon name="ph-arrow-up-right" size={13} color="var(--tt)" style={{ flex: 'none', marginTop: 2 }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MissionGroup
// ---------------------------------------------------------------------------

function MissionGroup({ mission }: { mission: Mission }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* mission header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 2px',
          gap: 8,
        }}
      >
        {/* 5px dot */}
        <span
          style={{
            flex: 'none',
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: 'var(--ts)',
            display: 'inline-block',
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tp)' }}>{mission.name}</span>
        <span style={{ flex: 1 }} />
        <MonoLabel size={10} color="var(--tt)" spacing="0">
          {mission.summary}
        </MonoLabel>
      </div>

      {/* thread chips */}
      {mission.threads.map((thread) => (
        <AgentThreadChip key={thread.key} thread={thread} />
      ))}

      {/* outcome cards */}
      {mission.outcomes.map((outcome) => (
        <OutcomeCard key={outcome.key} outcome={outcome} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyMissions
// ---------------------------------------------------------------------------

function EmptyMissions({ isMobile }: { isMobile: boolean }) {
  const openDelegate = useOverseer((s) => s.openDelegate);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 13,
        marginTop: 24,
        padding: '0 16px',
        textAlign: 'center',
      }}
    >
      {/* stack icon box */}
      <div
        style={{
          width: 46,
          height: 46,
          borderRadius: 12,
          background: 'var(--elev)',
          border: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--tt)',
          fontSize: 22,
        }}
      >
        <Icon name="ph-stack" size={22} color="var(--tt)" />
      </div>

      {/* text */}
      <p style={{ fontSize: 13, color: 'var(--ts)', lineHeight: 1.5, margin: 0 }}>
        No missions yet.
        <br />
        {isMobile
          ? 'Fire a directive to begin.'
          : 'Fire a directive, or delegate your first task.'}
      </p>

      {/* CTA button */}
      <button
        onClick={openDelegate}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '7px 13px',
          borderRadius: 8,
          background: 'var(--acc)',
          color: '#06140B',
          border: 'none',
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        <Icon name="ph-plus" weight="bold" size={13} color="#06140B" />
        Delegate a task
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RailHeader
// ---------------------------------------------------------------------------

function RailHeader() {
  const openDelegate = useOverseer((s) => s.openDelegate);

  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        padding: '13px 16px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <MonoLabel size={10.5} color="var(--tt)" spacing=".09em">
        Ongoing work
      </MonoLabel>
      <span style={{ flex: 1 }} />
      <button
        onClick={openDelegate}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 11px',
          borderRadius: 8,
          background: 'var(--acc)',
          color: '#06140B',
          border: 'none',
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        <Icon name="ph-plus" weight="bold" size={13} color="#06140B" />
        Delegate
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OngoingWorkOverview — the exported component
// ---------------------------------------------------------------------------

export function OngoingWorkOverview() {
  const isMobile = useIsMobile();
  const rv = useRenderVals();
  const openDelegate = useOverseer((s) => s.openDelegate);
  const { missions, noMissions } = rv;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* header — desktop: "Ongoing work" + Delegate; mobile: same (RailHeader is shared) */}
      <RailHeader />

      {/* mobile-only: full-width "Delegate a task" primary CTA at top of scroll area */}
      {isMobile && (
        <div style={{ flex: 'none', padding: '12px 16px 0' }}>
          <button
            onClick={openDelegate}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              width: '100%',
              padding: '10px 0',
              borderRadius: 9,
              background: 'var(--acc)',
              color: '#06140B',
              border: 'none',
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Icon name="ph-plus" weight="bold" size={14} color="#06140B" />
            Delegate a task
          </button>
        </div>
      )}

      {/* scroll body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '15px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        {noMissions ? (
          <EmptyMissions isMobile={isMobile} />
        ) : (
          missions.map((mission) => <MissionGroup key={mission.key} mission={mission} />)
        )}
      </div>
    </div>
  );
}
