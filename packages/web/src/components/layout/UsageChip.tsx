import { HEADER_BOX } from './headerButton';
import { useEffect, useRef, useState } from 'react';
import { useNow } from '../../hooks/useNow';
import { useUsageLimits } from '../../stores/usageLimits';
import type { UsageSummary } from '../../api/types';
import { Modal } from '../common/Modal';
import { UsageRings } from './UsageRings';
import { chipModel, usageTables, bannerText, TONE_COLOR, CLI_NOTE } from './usageGauge';

/** Every provider's windows, resets and "As of", plus any pause. The popover, the phone sheet and Settings share it. */
export function UsageTable({ summary, now }: { summary: UsageSummary | null; now: number }) {
  const tables = usageTables(summary, now);
  if (!summary || tables.length === 0) return <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>No figures reported yet</div>;
  return (
    <div data-testid="usage-table" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {tables.map((t) => (
        <div key={t.provider} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--color-text-primary)' }}>{t.name}</span>
            {t.plan && <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{t.plan}</span>}
          </div>
          {t.rows.length === 0 && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>No limits reported</div>}
          {t.rows.map((r) => (
            <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, minWidth: 0 }}>
              <span style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }}>{r.label}</span>
              <span style={{ color: r.tone === 'normal' ? 'var(--color-text-primary)' : TONE_COLOR[r.tone], textAlign: 'right', overflowWrap: 'anywhere' }}>{r.value}</span>
            </div>
          ))}
          <div style={{ font: '400 11px var(--font-mono)', color: t.stale ? 'var(--color-status-yellow)' : 'var(--color-text-tertiary)' }}>{t.asOf}</div>
        </div>
      ))}
      {summary.paused.map((g) => (
        <div key={g.provider} style={{ fontSize: 12, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>{bannerText(g, now)}</div>
      ))}
      <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>Warning at {summary.warnPercent}%. {CLI_NOTE}</div>
    </div>
  );
}

/**
 * The header usage chip (#127). Hidden until a provider reports. `rail`: the desktop icon rail,
 * 64 px wide, so two stacked lines (`5h 46`, `wk 21`) and a popover. `phone`: the mobile header
 * next to the alert bell, one value (the higher window) and a bottom sheet.
 */
export function UsageChip({ variant }: { variant: 'rail' | 'phone' }) {
  const summary = useUsageLimits((s) => s.summary);
  const now = useNow();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || variant !== 'rail') return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, variant]);
  const m = chipModel(summary, now);
  if (!m) return null;
  const color = TONE_COLOR[m.tone];
  const opacity = m.stale ? 0.5 : 1;

  if (variant === 'phone') {
    return (
      <>
        <button type="button" data-testid="usage-chip" data-tone={m.tone} aria-label={m.title} title={m.title} onClick={() => setOpen(true)}
          style={{ ...HEADER_BOX, minWidth: 44, padding: '0 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, ...(m.tone === 'normal' ? {} : { borderColor: color }), color, font: '600 13px var(--font-mono)', cursor: 'pointer' }}>
          {/* Stale figures dim the figure, not the button: the header's controls keep one weight. */}
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, opacity }}>
            {/* Just the figure (2026-11-06): the "C"/"X" tool letter read as noise. The label says which tool. */}
            {m.peak}
          </span>
        </button>
        <Modal open={open} sheet title="Usage" onClose={() => setOpen(false)}>
          <UsageRings summary={summary} now={now} />
        </Modal>
      </>
    );
  }

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <button type="button" data-testid="usage-chip" data-tone={m.tone} aria-label={m.title} title={m.title} aria-expanded={open} onClick={() => setOpen((o) => !o)}
        style={{ width: 52, padding: '4px 0', borderRadius: 'var(--radius-md)', border: `1px solid ${m.tone === 'normal' ? 'transparent' : color}`, background: open ? 'var(--color-elevated)' : 'transparent', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, color, opacity, font: '500 10px var(--font-mono)', lineHeight: '13px' }}>
        {m.mark && <span style={{ fontSize: 8.5, opacity: 0.8 }}>{m.mark}</span>}
        {/* Only a tool that reports a 5-hour window gets the line (neither Claude nor Codex did on 2026-11-05). */}
        {m.five !== '–' && <span style={{ whiteSpace: 'nowrap' }}>5h {m.five}</span>}
        <span style={{ whiteSpace: 'nowrap' }}>wk {m.week}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Usage limits" style={{ position: 'absolute', left: 58, bottom: 0, zIndex: 300, width: 380, maxWidth: 'calc(100vw - 80px)', boxSizing: 'border-box', padding: 14, background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: '0 20px 60px -20px rgba(0,0,0,.8)' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>Usage</div>
          <UsageRings summary={summary} now={now} />
        </div>
      )}
    </div>
  );
}
