// Overseer view — NeedsZone component (spec §6 "Needs zone", §5 Need, §7 copy, §8 icons).
//
// Desktop hero: yellow-gradient container (flex:none, max-height 62%, scrollable) above
// the conversation stream. One NeedCard per rv.needs: conflict has two side-by-side
// context panels with ⇆ divider; approval has mono command chips; question has framing
// only. Each card has action buttons that call store.needAction(id, label).
//
// Mobile: stacked conflict panels (no ⇆), no "raised by Overseer" tag, fills tab height
// with its own scroll.

import { useIsMobile } from '../../../hooks/useIsMobile';
import { Icon, MonoLabel, PillButton } from '../atoms';
import { useOverseer, useRenderVals } from '../store';
import type { Need, NeedAction } from '../types';

// ---------------------------------------------------------------------------
// Conflict panels — two side-by-side (desktop) or stacked (mobile) context boxes
// ---------------------------------------------------------------------------

function ConflictPanels({ need, isMobile }: { need: Need; isMobile: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        gap: 10,
        marginBottom: 13,
      }}
    >
      {/* Left / top panel — approved plan (accent) */}
      <div
        style={{
          flex: 1,
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '10px 11px',
          background: 'var(--pane)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Icon name={need.aIcon!} weight="fill" size={13} color="var(--acc)" />
          <MonoLabel size={9.5} spacing=".06em" color="var(--ts)">
            {need.aLabel}
          </MonoLabel>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--tp)' }}>{need.aText}</div>
      </div>

      {/* Center divider — desktop only */}
      {!isMobile && (
        <div style={{ alignSelf: 'center', flex: 'none' }}>
          <Icon name="ph-arrows-left-right" weight="bold" size={14} color="var(--tt)" />
        </div>
      )}

      {/* Right / bottom panel — your note (yellow border, italic) */}
      <div
        style={{
          flex: 1,
          border: '1px solid var(--yellowLine)',
          borderRadius: 8,
          padding: '10px 11px',
          background: 'var(--pane)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Icon name={need.bIcon!} weight="fill" size={13} color="var(--yellow)" />
          <MonoLabel size={9.5} spacing=".06em" color="var(--ts)">
            {need.bLabel}
          </MonoLabel>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--tp)', fontStyle: 'italic' }}>
          {need.bText}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approval command chips
// ---------------------------------------------------------------------------

function ApprovalCommands({ cmds }: { cmds: string[] }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginBottom: 13,
      }}
    >
      {cmds.map((cmd) => (
        <span
          key={cmd}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--mono)',
            fontSize: 11.5,
            color: 'var(--tp)',
            background: 'var(--pane)',
            border: '1px solid var(--border)',
            borderRadius: 7,
            padding: '7px 10px',
            alignSelf: 'flex-start',
          }}
        >
          <Icon name="ph-terminal-window" size={13} color="var(--tt)" />
          {cmd}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions row
// ---------------------------------------------------------------------------

function NeedActions({
  actions,
  needId,
  onAction,
}: {
  actions: NeedAction[];
  needId: string;
  onAction: (id: string, label: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {actions.map((a) => (
        <PillButton
          key={a.label}
          bg={a.bg}
          fg={a.fg}
          bd={a.bd}
          onClick={() => onAction(needId, a.label)}
        >
          {a.label}
        </PillButton>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual need card
// ---------------------------------------------------------------------------

function NeedCard({
  need,
  isMobile,
  onAction,
}: {
  need: Need;
  isMobile: boolean;
  onAction: (id: string, label: string) => void;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 11,
        background: 'var(--elev)',
        overflow: 'hidden',
      }}
    >
      {/* Card header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '11px 13px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <Icon name={need.icon} weight="fill" size={16} color="var(--yellow)" />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tp)' }}>{need.title}</span>
        <span style={{ flex: 1 }} />
        {/* "raised by Overseer" — desktop only */}
        {!isMobile && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              color: 'var(--tt)',
            }}
          >
            <Icon name="ph-broadcast" size={11} color="var(--tt)" />
            raised by Overseer
          </span>
        )}
      </div>

      {/* Card body */}
      <div style={{ padding: '12px 13px' }}>
        {/* Framing */}
        <p
          style={{
            margin: 0,
            fontSize: 12.5,
            lineHeight: 1.55,
            color: 'var(--ts)',
            marginBottom: 12,
          }}
        >
          {need.framing}
        </p>

        {/* Conflict panels */}
        {need.isConflict && <ConflictPanels need={need} isMobile={isMobile} />}

        {/* Approval command chips */}
        {need.isApproval && need.cmds && <ApprovalCommands cmds={need.cmds} />}

        {/* Actions */}
        <NeedActions actions={need.actions} needId={need.id} onAction={onAction} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone header
// ---------------------------------------------------------------------------

function NeedsZoneHeader({ count }: { count: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        marginBottom: 12,
      }}
    >
      <Icon name="ph-warning" weight="fill" size={15} color="var(--yellow)" />
      <MonoLabel color="var(--yellow)" size={10.5} spacing=".09em">
        Needs you
      </MonoLabel>
      <MonoLabel color="var(--tt)" size={10.5} spacing=".09em">
        {count} held · everything else is handled
      </MonoLabel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NeedsZone — exported root component (spec §6)
// ---------------------------------------------------------------------------

export function NeedsZone() {
  const rv = useRenderVals();
  const needAction = useOverseer((s) => s.needAction);
  const isMobile = useIsMobile();

  const { needs } = rv;
  const count = rv.ribbon.needs;

  // Desktop: flex:none, max-height 62%, yellow gradient, own scroll.
  // Mobile: flex:1, fill tab height, own scroll.
  const containerStyle = isMobile
    ? {
        flex: 1,
        minHeight: 0,
        overflowY: 'auto' as const,
        padding: '15px 16px 18px',
      }
    : {
        flex: 'none' as const,
        maxHeight: '62%',
        overflowY: 'auto' as const,
        borderBottom: '1px solid var(--border)',
        background: 'linear-gradient(180deg,rgba(245,197,66,.045),transparent 60%)',
        padding: '15px 22px 18px',
      };

  return (
    <div style={containerStyle}>
      <NeedsZoneHeader count={count} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {needs.map((need) => (
          <NeedCard key={need.id} need={need} isMobile={isMobile} onAction={needAction} />
        ))}
      </div>
    </div>
  );
}
