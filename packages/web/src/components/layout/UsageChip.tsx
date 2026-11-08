import { HEADER_BOX } from './headerButton';
import { useEffect, useRef, useState } from 'react';
import { useNow } from '../../hooks/useNow';
import { useUsageLimits } from '../../stores/usageLimits';
import { useSettings } from '../../stores/settings';
import type { UsageSummary } from '../../api/types';
import { Modal } from '../common/Modal';
import { UsageRings } from './UsageRings';
import { chipRings, chipTone, usageTables, bannerText, TONE_COLOR, RING_COLOR, CLI_NOTE, type ChipRing } from './usageGauge';
import { HARNESS_MARK } from '../common/HarnessStrip';

/** Every provider's windows, resets and "As of", plus any pause. The popover, the phone sheet and Settings share it. */
export function UsageTable({ summary, now }: { summary: UsageSummary | null; now: number }) {
  const tables = usageTables(summary, now);
  if (!summary || (tables.length === 0 && summary.paused.length === 0)) return <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>No figures reported yet</div>;
  return (
    <div data-testid="usage-table" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* A pause can come before any figure (a paused Codex with no snapshot): its line still shows. */}
      {tables.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>No figures reported yet</div>}
      {tables.map((t) => (
        <div key={`${t.provider}|${t.accountId}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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

/** The brand mark for a provider id (`claude-code` → the Claude mark). */
const MARK_KEY: Record<string, string> = { 'claude-code': 'claude', codex: 'codex', grok: 'grok', opencode: 'opencode' };

/**
 * One tool's ring (2026-11-06): a circle that fills with the window closest to its limit, the
 * tool's mark in the middle. Green, then yellow, then red, like the sheet; a paused tool is red.
 */
export function ProviderRing({ ring, size }: { ring: ChipRing; size: number }) {
  const stroke = Math.max(2, Math.round(size / 11));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const used = ring.used ?? 0;
  const Mark = HARNESS_MARK[MARK_KEY[ring.provider] ?? ''];
  const percent = useSettings((st) => st.usageRingCenter) === 'percent';
  return (
    <span data-testid="usage-ring" data-provider={ring.provider} data-account={ring.accountId} data-tone={ring.tone} role="meter" aria-label={ring.title}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={ring.used ?? undefined}
      style={{ position: 'relative', width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: ring.stale ? 0.55 : 1 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-hover)" strokeWidth={stroke} />
        {used > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={RING_COLOR[ring.tone]} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${(Math.min(100, used) / 100) * c} ${c}`} />}
        {ring.paused && used === 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={RING_COLOR.red} strokeWidth={stroke} strokeDasharray={`${c / 8} ${c / 8}`} />}
      </svg>
      {percent ? <span style={{ font: `600 ${Math.round(size * (String(ring.used ?? '–').length > 2 ? 0.3 : 0.38))}px var(--font-mono)`, color: 'var(--color-text-primary)', letterSpacing: '-0.03em' }}>{ring.used ?? '–'}</span>
        : Mark ? <Mark size={Math.round(size * 0.46)} /> : <span style={{ font: `600 ${Math.round(size * 0.38)}px var(--font-mono)`, color: 'var(--color-text-secondary)' }}>{ring.name.slice(0, 1)}</span>}
    </span>
  );
}

/**
 * The header usage chip (#127, rings since 2026-11-06). Hidden until a provider reports. One ring
 * per tool with its mark in the middle: `rail` stacks them in the desktop icon rail and opens a
 * popover; `phone` lays them in a row in the mobile header and opens a bottom sheet. The whole
 * chip is one button. `only` (an open thread, 2026-11-07) keeps the ring of that thread's account
 * alone; a thread whose tool reports no limits shows no chip.
 */
export function UsageChip({ variant, only, hideAll }: { variant: 'rail' | 'phone'; only?: { provider: string; accountId: string; model?: string | null } | null; hideAll?: boolean }) {
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
  const all = chipRings(summary, now, undefined, { model: only?.model });
  const rings = only ? all.filter((r) => r.provider === only.provider && (r.accountId ?? 'cli') === only.accountId) : all;
  // The phone's all-accounts rings can be turned off (owner, 2026-11-07); a thread's own ring stays.
  if (!summary || rings.length === 0 || (hideAll && !only)) return null;
  const tone = chipTone(rings, summary.warnPercent);
  const color = TONE_COLOR[tone];
  const title = `Usage. ${rings.map((r) => r.title).join('. ')}`;

  if (variant === 'phone') {
    return (
      <>
        <button type="button" data-testid="usage-chip" data-tone={tone} aria-label={title} title={title} onClick={() => setOpen(true)}
          style={{ ...HEADER_BOX, minWidth: 44, padding: '0 7px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, cursor: 'pointer' }}>
          {rings.map((r) => <ProviderRing key={`${r.provider}|${r.accountId}`} ring={r} size={24} />)}
        </button>
        <Modal open={open} sheet title="Usage" onClose={() => setOpen(false)}>
          <UsageRings summary={summary} now={now} current={only} />
        </Modal>
      </>
    );
  }

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <button type="button" data-testid="usage-chip" data-tone={tone} aria-label={title} title={title} aria-expanded={open} onClick={() => setOpen((o) => !o)}
        style={{ width: 52, padding: '6px 0', borderRadius: 'var(--radius-md)', border: '1px solid transparent', background: open ? 'var(--color-elevated)' : 'transparent', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        {rings.map((r) => <ProviderRing key={`${r.provider}|${r.accountId}`} ring={r} size={30} />)}
      </button>
      {open && (
        <div role="dialog" aria-label="Usage limits" style={{ position: 'absolute', left: 58, bottom: 0, zIndex: 300, width: 380, maxWidth: 'calc(100vw - 80px)', boxSizing: 'border-box', padding: 14, background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: '0 20px 60px -20px var(--color-shadow-strong)' }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>Usage</div>
          <UsageRings summary={summary} now={now} current={only} />
        </div>
      )}
    </div>
  );
}
