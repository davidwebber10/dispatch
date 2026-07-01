// Overseer view — desktop header (spec §6 "Header (desktop, 54px)").
//
// BrandBadge: coordinator display name (configurable, see useDispatchName) + "dispatch" chip.
// StatusRibbon: NeedsAlert (⚠ + count → opens the held-items popover) · "N done today" ·
// divider · "Connected" (static dot) · reset · gear. (The live working-count no longer rides
// the header — it moved onto the Work tab as a pulsing count pill; see OverseerMobile. Desktop
// keeps surfacing it via the work rail's "Live N" toggle — see WorkRail.)
//
// Desktop-only: the mobile header is rendered inline by OverseerMobile (which reuses the
// same NeedsAlert). Reads: useRenderVals().ribbon + useOverseer(s => s.resetDispatch).

import type { CSSProperties } from 'react';
import { Icon, StatusDot } from '../atoms';
import { useOverseer, useRenderVals } from '../store';
import type { Ribbon } from '../types';
import { useDispatchName } from '../../../stores/settings';
import { NeedsAlert } from './NeedsAlert';

// ─── BrandBadge ──────────────────────────────────────────────────────────────

function BrandBadge() {
  const name = useDispatchName();
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {/* Title block: the coordinator's configurable display name (see useDispatchName) */}
      <div style={{ lineHeight: 1.15 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--tp)' }}>{name}</div>
      </div>

      {/* "dispatch" project chip — mono, folder icon, margin-left 6px from title block */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginLeft: 6,
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'var(--tt)',
        }}
      >
        <Icon name="ph-folder-simple" size={12} color="var(--tt)" />
        dispatch
      </div>
    </div>
  );
}

// ─── StatusRibbon ─────────────────────────────────────────────────────────────

// Chip wrapper shared by "N working" and "N done today"
const chipBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  borderRadius: 8,
  fontSize: 12,
};

function StatusRibbon({
  ribbon,
  onReset,
}: {
  ribbon: Ribbon;
  onReset: () => void;
}) {
  const { done } = ribbon;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {/* "Needs you" alert — ⚠ + count; click opens the held-items popover (replaces the
          old inline needs zone + "N need you" ribbon button). */}
      <NeedsAlert />

      {/* "N done today" chip — no bg, check-circle icon */}
      <div
        style={{
          ...chipBase,
          gap: 5,
          color: 'var(--tt)',
        }}
      >
        <Icon name="ph-check-circle" size={13} color="var(--tt)" />
        {done} done today
      </div>

      {/* 1px × 22px vertical divider */}
      <div style={{ width: 1, height: 22, background: 'var(--border)', flex: 'none' }} />

      {/* "Connected" — static accent dot + label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <StatusDot color="var(--acc)" anim="none" />
        <span style={{ fontSize: 11.5, color: 'var(--ts)' }}>Connected</span>
      </div>

      {/* Reset Dispatch — clean slate (archives the conversation + its agents) */}
      <button
        onClick={onReset}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
        title="Reset Dispatch — start a fresh conversation (archives the current chat and its agents)"
      >
        <Icon name="ph-arrow-clockwise" size={15} color="var(--tt)" />
      </button>

      {/* Gear settings icon */}
      <button
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
        title="Settings"
      >
        <Icon name="ph-gear" size={16} color="var(--tt)" />
      </button>
    </div>
  );
}

// ─── OverseerHeader ───────────────────────────────────────────────────────────

export function OverseerHeader() {
  const { ribbon } = useRenderVals();
  const resetDispatch = useOverseer((s) => s.resetDispatch);
  const onReset = () => {
    if (window.confirm('Reset Dispatch to a clean slate?\n\nThis archives the current conversation and dismisses its agents, then starts fresh.')) {
      resetDispatch();
    }
  };

  return (
    <header
      style={{
        flex: 'none',
        height: 54,
        background: 'var(--pane)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 18px',
      }}
    >
      <BrandBadge />

      {/* Spacer pushes the ribbon to the right */}
      <div style={{ flex: 1, minWidth: 0 }} />

      <StatusRibbon ribbon={ribbon} onReset={onReset} />
    </header>
  );
}
