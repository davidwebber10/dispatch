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
import { Icon, MonoLabel, StatusDot, TypeIconBox } from '../atoms';
import { Spinner } from '../../common/Spinner';
import { useOverseer, useRenderVals } from '../store';
import type { AgentThread, Mission, Outcome } from '../types';

// Which slice of each mission the rail shows: LIVE (in-progress AgentThreadChips) — the
// default, keeping the view to only active work — QUEUED (accepted-but-unlaunched workers,
// each with a Start button) — or DONE (finished/archived OutcomeCards).
type RailTab = 'live' | 'queued' | 'done';

// live.groupByMission tags each mission with `doneFreshness` — the most-recent "last active"
// stamp among its DONE agents (0 if none). It's additive (not on the Mission contract), so we
// read it through this local widening only where the Done tab needs it.
type MissionRow = Mission & { doneFreshness?: number };
const doneFreshness = (m: Mission): number => (m as MissionRow).doneFreshness ?? 0;

// ---------------------------------------------------------------------------
// AgentThreadChip
// ---------------------------------------------------------------------------

function AgentThreadChip({ thread }: { thread: AgentThread }) {
  const drillInto = useOverseer((s) => s.drillInto);
  const [hovered, setHovered] = useState(false);

  // The agent's OWN descriptive name (its spawn label, carried on dlabel) is the prominent
  // line so running agents are told apart at a glance — type · #id + status drop to small
  // secondary meta. Falls back to type #id if a worker was spawned without a name.
  const name = thread.dlabel || `${thread.typeLabel} #${thread.id}`;
  // A real live-activity string only earns a line when it's distinct from the name (else it
  // would just echo the title) AND distinct from the backend's generic "no specific activity
  // yet" placeholder (statusService.markWorking(id, 'Working…') on resolved/busy — see
  // packages/core/src/server.ts). The top-right status pill already carries the working cue,
  // so the body row simply drops out rather than shimmering that filler word.
  const bodyText = thread.action && thread.action !== name && thread.action !== 'Working…' ? thread.action : '';

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
        padding: '8px 12px',
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
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* row 1: descriptive name (primary) + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--tp)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {name}
          </span>
          {/* Working → just the shared app spinner (no "working" word). Every other status
              (waiting/error) keeps its dot + mono label. Queued/done use their own chips. */}
          {thread.isWorking ? (
            <Spinner size={12} />
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none' }}>
              <StatusDot color={thread.dotColor} anim={thread.dotAnim} size={6} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ts)' }}>
                {thread.statusLabel}
              </span>
            </span>
          )}
        </div>

        {/* row 2: secondary meta — type · #id (· model, when known) + elapsed */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ts)' }}>
            {thread.typeLabel} · #{thread.id}
          </span>
          {thread.model && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)' }}>{thread.model}</span>
          )}
          <span style={{ flex: 1 }} />
          {thread.elapsed && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)', flex: 'none' }}>
              {thread.elapsed}
            </span>
          )}
        </div>

        {/* row 3: live activity — shimmers while working (an indeterminate cue; no progress bar,
            since an agent's work has no determinate percentage). Reuses the shared chat-shimmer
            class (same primitive WorkingIndicator uses). */}
        {bodyText && (
          <div
            className={thread.isWorking ? 'chat-shimmer' : undefined}
            style={{
              fontSize: 12.5,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              // chat-shimmer paints its own gradient text via background-clip; an inline color
              // would override it, so only set a color when NOT shimmering.
              ...(thread.isWorking ? null : { color: 'var(--ts)' }),
            }}
          >
            {bodyText}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// QueuedChip — an accepted-but-unlaunched worker (status='queued'), with a Start button
// ---------------------------------------------------------------------------

function QueuedChip({ thread }: { thread: AgentThread }) {
  const startAgent = useOverseer((s) => s.startAgent);
  const [hovered, setHovered] = useState(false);

  // Same identity line as the live chip — its own spawn name, falling back to type #id.
  const name = thread.dlabel || `${thread.typeLabel} #${thread.id}`;

  return (
    <div
      data-key={thread.key}
      data-label={thread.dlabel}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        padding: '8px 10px 8px 12px',
        background: hovered ? 'var(--hover)' : 'var(--elev)',
        border: `1px dashed ${hovered ? '#36363c' : 'var(--border)'}`,
        borderRadius: 9,
        transition: 'background 0.12s, border-color 0.12s',
      }}
    >
      {/* type icon box */}
      <TypeIconBox icon={thread.typeIcon} size={28} />

      {/* body */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* row 1: descriptive name (primary) + queued status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--tp)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {name}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none' }}>
            <StatusDot color={thread.dotColor} anim="none" size={6} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ts)' }}>
              {thread.statusLabel}
            </span>
          </span>
        </div>

        {/* row 2: secondary meta — type · #id */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ts)' }}>
            {thread.typeLabel} · #{thread.id}
          </span>
        </div>
      </div>

      {/* Start → launch this queued worker now */}
      <button
        onClick={() => startAgent(thread.key)}
        title="Start this agent now"
        style={{
          flex: 'none',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '5px 11px',
          borderRadius: 7,
          background: 'var(--acc)',
          color: '#06140B',
          border: 'none',
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        <Icon name="ph-lightning" weight="fill" size={12} color="#06140B" />
        Start
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OutcomeCard
// ---------------------------------------------------------------------------

function OutcomeCard({ outcome }: { outcome: Outcome }) {
  const drillInto = useOverseer((s) => s.drillInto);
  const [hovered, setHovered] = useState(false);

  return (
    <div
      data-key={outcome.key}
      onClick={() => drillInto(outcome.key)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        gap: 10,
        padding: '9px 12px',
        background: hovered ? 'var(--hover)' : 'transparent',
        border: `1px dashed ${hovered ? '#36363c' : 'var(--border)'}`,
        borderRadius: 9,
        alignItems: 'flex-start',
        cursor: 'pointer',
        transition: 'background 0.12s, border-color 0.12s',
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

      {/* link arrow — brightens on hover now that the card opens the retained transcript */}
      <Icon
        name="ph-arrow-up-right"
        size={13}
        color={hovered ? 'var(--ts)' : 'var(--tt)'}
        style={{ flex: 'none', marginTop: 2 }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MissionGroup
// ---------------------------------------------------------------------------

function MissionGroup({ mission, tab }: { mission: Mission; tab: RailTab }) {
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

      {/* entries for the active tab: LIVE → thread chips, QUEUED → start-able chips, DONE → outcome cards */}
      {tab === 'live'
        ? mission.threads.map((thread) => <AgentThreadChip key={thread.key} thread={thread} />)
        : tab === 'queued'
          ? mission.queued.map((thread) => <QueuedChip key={thread.key} thread={thread} />)
          : mission.outcomes.map((outcome) => <OutcomeCard key={outcome.key} outcome={outcome} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilterToggle — LIVE / DONE segmented control (local rail state)
// ---------------------------------------------------------------------------

function FilterToggle({
  tab,
  onTab,
  liveCount,
  queuedCount,
  doneCount,
}: {
  tab: RailTab;
  onTab: (t: RailTab) => void;
  liveCount: number;
  queuedCount: number;
  doneCount: number;
}) {
  const seg = (value: RailTab, label: string, count: number) => {
    const active = tab === value;
    return (
      <button
        onClick={() => onTab(value)}
        style={{
          padding: '3px 10px',
          borderRadius: 6,
          border: 'none',
          background: active ? 'var(--elev)' : 'transparent',
          color: active ? 'var(--tp)' : 'var(--ts)',
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'background 0.12s, color 0.12s',
        }}
      >
        {label}
        {count > 0 && (
          <span style={{ marginLeft: 5, color: active ? 'var(--ts)' : 'var(--tt)' }}>{count}</span>
        )}
      </button>
    );
  };

  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        background: 'var(--pane)',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}
    >
      {seg('live', 'Live', liveCount)}
      {seg('queued', 'Queued', queuedCount)}
      {seg('done', 'Done', doneCount)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyFilter — nothing in the active tab (but missions exist in the other)
// ---------------------------------------------------------------------------

function EmptyFilter({ tab }: { tab: RailTab }) {
  return (
    <div style={{ marginTop: 18, padding: '0 4px', textAlign: 'center' }}>
      <p style={{ fontSize: 12.5, color: 'var(--ts)', lineHeight: 1.5, margin: 0 }}>
        {tab === 'live'
          ? 'No active work right now.'
          : tab === 'queued'
            ? 'Nothing queued.'
            : 'Nothing finished yet.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyMissions
// ---------------------------------------------------------------------------

function EmptyMissions() {
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
        Tell Dispatch what to work on.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RailHeader
// ---------------------------------------------------------------------------

function RailHeader({
  tab,
  onTab,
  liveCount,
  queuedCount,
  doneCount,
}: {
  tab: RailTab;
  onTab: (t: RailTab) => void;
  liveCount: number;
  queuedCount: number;
  doneCount: number;
}) {
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '13px 16px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <MonoLabel size={10.5} color="var(--tt)" spacing=".09em">
        Ongoing work
      </MonoLabel>
      <span style={{ flex: 1 }} />
      <FilterToggle tab={tab} onTab={onTab} liveCount={liveCount} queuedCount={queuedCount} doneCount={doneCount} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// OngoingWorkOverview — the exported component
// ---------------------------------------------------------------------------

export function OngoingWorkOverview() {
  const rv = useRenderVals();
  const { missions, noMissions } = rv;

  // Local rail state — default LIVE so the rail opens on active work only; DONE is one tap
  // away. Kept in the component (not the store) by design.
  const [tab, setTab] = useState<RailTab>('live');

  const liveCount = missions.reduce((n, mm) => n + mm.threads.length, 0);
  const queuedCount = missions.reduce((n, mm) => n + mm.queued.length, 0);
  const doneCount = missions.reduce((n, mm) => n + mm.outcomes.length, 0);
  // Count of the active tab's entries for a given mission (drives which missions are shown).
  const countInTab = (mm: Mission) =>
    tab === 'live' ? mm.threads.length : tab === 'queued' ? mm.queued.length : mm.outcomes.length;
  // Only missions that actually have an entry in the active tab — keeps the view uncluttered.
  const inTab = missions.filter((mm) => countInTab(mm) > 0);
  // Done tab: float the mission with the most-recently-active finished work to the top (its
  // outcomes are already newest-first from live.groupByMission). Live tab keeps its natural
  // group order untouched.
  const visible =
    tab === 'done' ? [...inTab].sort((a, b) => doneFreshness(b) - doneFreshness(a)) : inTab;

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
      {/* header — "Ongoing work" label + Live/Queued/Done toggle (shared desktop + mobile) */}
      <RailHeader tab={tab} onTab={setTab} liveCount={liveCount} queuedCount={queuedCount} doneCount={doneCount} />

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
          <EmptyMissions />
        ) : visible.length === 0 ? (
          <EmptyFilter tab={tab} />
        ) : (
          visible.map((mission) => <MissionGroup key={mission.key} mission={mission} tab={tab} />)
        )}
      </div>
    </div>
  );
}
