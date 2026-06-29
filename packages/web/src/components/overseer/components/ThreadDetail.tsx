// Overseer view — thread detail / drill-in (spec §6 "Work rail — thread detail",
// §5 ThreadDetail/DrillStep, §7 copy, §8 icons).
//
// Renders the drill-in view that swaps the right rail (desktop) or fills the
// full-screen overlay (mobile). Reads rv.drillDetail from useRenderVals() and
// closeDrill from useOverseer(). Accepts an optional `mobile` prop: when true
// (or when useIsMobile() fires) the Interrupt / "Open raw terminal" controls
// row is omitted and the redirect placeholder is shortened (spec §1c).

import { Icon, MonoLabel, StatusDot, TypeIconBox } from '../atoms';
import { useOverseer, useRenderVals } from '../store';
import { useIsMobile } from '../../../hooks/useIsMobile';

export function ThreadDetail({ mobile }: { mobile?: boolean }) {
  const rv = useRenderVals();
  const closeDrill = useOverseer((s) => s.closeDrill);
  const isMobile = useIsMobile();
  const isMobileView = mobile ?? isMobile;

  const detail = rv.drillDetail;
  if (!detail) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '12px 14px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {/* Back button → closeDrill */}
        <button
          onClick={closeDrill}
          title="Back to overview"
          style={{
            flex: 'none',
            width: 28,
            height: 28,
            borderRadius: 7,
            background: 'var(--elev)',
            border: '1px solid var(--border)',
            color: 'var(--ts)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <Icon name="ph-arrow-left" size={15} />
        </button>

        {/* Agent-type icon box */}
        <TypeIconBox icon={detail.typeIcon} size={28} />

        {/* Two-line text block: typeLabel · #id + mission (flex:1) */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tp)', lineHeight: 1.2 }}>
            {detail.typeLabel} · #{detail.id}
          </span>
          <MonoLabel size={10}>{detail.mission}</MonoLabel>
        </div>

        {/* Status dot + label · elapsed */}
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <StatusDot color={detail.dotColor} anim={detail.dotAnim} size={6} />
          <span style={{ fontSize: 10.5, color: 'var(--ts)', whiteSpace: 'nowrap' }}>
            {detail.statusLabel} · {detail.elapsed}
          </span>
        </div>
      </div>

      {/* ── Scrollable body ─────────────────────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '14px 16px',
        }}
      >
        {/* Co-driving banner */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 9,
            padding: '9px 11px',
            border: '1px solid var(--accLine)',
            background: 'var(--accDim)',
            borderRadius: 9,
            marginBottom: 16,
          }}
        >
          <span style={{ flex: 'none', display: 'flex', marginTop: 1 }}>
            <Icon name="ph-steering-wheel" weight="fill" size={15} color="var(--acc)" />
          </span>
          <span style={{ fontSize: 12, color: 'var(--tp)', lineHeight: 1.5 }}>
            {isMobileView
              ? "You’re steering this thread — Dispatch holds everything else."
              : "You’re steering this thread — Dispatch is holding everything else."}
          </span>
        </div>

        {/* "Activity" section label */}
        <MonoLabel size={10} spacing=".09em">Activity</MonoLabel>

        {/* Activity timeline */}
        <div style={{ margin: '11px 0 16px' }}>
          {detail.steps.map((step, i) => {
            const isLast = i === detail.steps.length - 1;
            return (
              <div
                key={step.key}
                style={{
                  display: 'flex',
                  gap: 11,
                  alignItems: 'flex-start',
                }}
              >
                {/* Left gutter: icon + vertical connector (connector hidden on last step) */}
                <div
                  style={{
                    flex: 'none',
                    width: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    alignSelf: 'stretch',
                  }}
                >
                  <span style={{ flex: 'none' }}>
                    <Icon
                      name={step.icon}
                      size={14}
                      color={step.color}
                      style={{ animation: step.anim, display: 'block' }}
                    />
                  </span>
                  {!isLast && (
                    <div
                      style={{
                        flex: 1,
                        width: 1,
                        background: 'var(--border)',
                        margin: '3px 0',
                        minHeight: 6,
                      }}
                    />
                  )}
                </div>

                {/* Step text */}
                <span
                  style={{
                    fontSize: 12.5,
                    color: step.textColor,
                    lineHeight: 1.4,
                    paddingBottom: 12,
                  }}
                >
                  {step.text}
                </span>
              </div>
            );
          })}
        </div>

        {/* Current action chip */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--ts)',
            background: 'var(--elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '9px 11px',
            marginBottom: 14,
          }}
        >
          <span style={{ flex: 'none', display: 'flex' }}>
            <Icon name="ph-pencil-simple" size={13} color="var(--acc)" />
          </span>
          <span>{detail.action}</span>
        </div>

        {/* Surface note */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--ts)', lineHeight: 1.5 }}>
            {detail.surface}
          </span>
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          flex: 'none',
          borderTop: '1px solid var(--border)',
          padding: '11px 14px',
          background: 'var(--base)',
        }}
      >
        {/* Redirect input row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            background: 'var(--elev)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '6px 6px 6px 10px',
          }}
        >
          <input
            placeholder={
              isMobileView
                ? 'Redirect #4…'
                : 'Redirect #4 — it folds in immediately…'
            }
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 12.5,
              color: 'var(--tp)',
              fontFamily: 'inherit',
              minWidth: 0,
            }}
          />
          <button
            style={{
              flex: 'none',
              padding: '6px 11px',
              borderRadius: 7,
              background: 'var(--acc)',
              color: '#06140B',
              border: 'none',
              fontSize: 11.5,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Send
          </button>
        </div>

        {/* Interrupt + Open raw terminal row — desktop only (spec §1c) */}
        {!isMobileView && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              marginTop: 9,
            }}
          >
            <button
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                border: '1px solid var(--border)',
                color: 'var(--red)',
                background: 'transparent',
                padding: '5px 10px',
                borderRadius: 7,
                fontSize: 11.5,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <Icon name="ph-hand-palm" size={13} color="var(--red)" />
              Interrupt
            </button>
            <span style={{ flex: 1 }} />
            {/* eslint-disable-next-line jsx-a11y/anchor-is-valid */}
            <a
              href="#"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                color: 'var(--tt)',
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              Open raw terminal
              <Icon name="ph-arrow-up-right" size={11} color="var(--tt)" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
