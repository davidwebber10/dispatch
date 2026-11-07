import { useEffect, useRef, useState } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import type { UsageSummary } from '../../api/types';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { ringModels, RING_COLOR, yellowFrom, bannerText, COUNTED, type RingModel, type RingRow } from './usageGauge';

/**
 * The usage sheet (2026-11-06, option A of the redesign): one card per tool, laid out like Claude's
 * own usage page. Each limit is a row: its name and how much is USED on the right, a thin bar that
 * fills as you use it (green, then yellow, then red), marks on the bar where yellow and red start,
 * and the reset time and run-out estimate underneath. Banked Codex resets sit below the limits.
 * The bars and numbers sweep into place when the sheet opens.
 */
const ANIM_MS = 700;
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** `used` eased from where it was to `target` over ANIM_MS (from 0 on first show). */
function useAnimatedUsed(target: number, reduced: boolean): number {
  const [shown, setShown] = useState(reduced ? target : 0);
  const from = useRef(reduced ? target : 0);
  useEffect(() => {
    if (reduced) { setShown(target); from.current = target; return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - start) / ANIM_MS));
      const eased = 1 - Math.pow(1 - k, 3); // ease-out
      const v = a + (target - a) * eased;
      setShown(v);
      from.current = v;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);
  return shown;
}

function LimitRow({ toolName, row, warn, first }: { toolName: string; row: RingRow; warn: number; first: boolean }) {
  const reduced = usePrefersReducedMotion();
  const target = 100 - (row.left ?? 0);
  const used = useAnimatedUsed(target, reduced);
  const color = RING_COLOR[row.tone];
  const label = cap(row.label);
  // Where the colour changes: yellow from yellowFrom(warn), red from the warning level.
  const marks: [number, string][] = [[yellowFrom(warn), RING_COLOR.yellow], [warn, RING_COLOR.red]];
  return (
    <div data-testid="usage-limit" style={{ padding: '11px 0', borderTop: first ? 'none' : '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 14.5, fontWeight: 500 }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 14.5, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: row.tone === 'green' ? 'var(--color-text-primary)' : color }}>
          {Math.round(used)}% <span style={{ fontSize: 12.5, fontWeight: 400, color: 'var(--color-text-secondary)' }}>used</span>
        </span>
      </div>
      <div role="meter" aria-label={`${toolName} ${row.label}: ${target}% used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={target}
        style={{ position: 'relative', height: 8, borderRadius: 'var(--radius-pill)', background: 'var(--color-hover)', margin: '9px 0 7px' }}>
        {used > 0.2 && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(1.2, Math.min(100, used))}%`, borderRadius: 'var(--radius-pill)', background: color }} />}
        {marks.map(([at, c]) => (
          <div key={at} aria-hidden style={{ position: 'absolute', left: `calc(${at}% - 1px)`, top: -3, bottom: -3, width: 2, borderRadius: 'var(--radius-xs)', background: c, opacity: 0.85 }} />
        ))}
      </div>
      {(row.reset || row.estimate) && (
        <div title={row.estimateTitle ?? undefined} style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          {row.reset ? cap(row.reset) : null}{row.reset && row.estimate ? ' · ' : ''}{row.estimate}
          {row.estimate && <span style={{ marginLeft: 5, font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)', padding: '0 4px', borderRadius: 'var(--radius-xs)', border: '1px solid var(--color-border)' }}>EST</span>}
        </div>
      )}
    </div>
  );
}

function ToolCard({ m, warn, current }: { m: RingModel; warn: number; current?: boolean }) {
  // A steady order (5-hour, then weekly, …), not closest-to-the-limit first, so rows never swap.
  const order = (t: string) => { const i = (COUNTED as readonly string[]).indexOf(t); return i < 0 ? 99 : i; };
  const rows = [...m.rows].sort((a, b) => order(a.type) - order(b.type));
  return (
    <section aria-label={m.name} data-current={current ? 'true' : undefined} style={{ background: 'var(--color-elevated)', border: `1px solid ${current ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 'var(--radius-lg)', padding: '4px 14px', minWidth: 0, opacity: m.stale ? 0.75 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '10px 0 2px' }}>
        <span style={{ fontSize: 17, fontWeight: 600 }}>{m.name}</span>
        {current && <span style={{ font: '500 10.5px var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-accent)', border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-pill)', padding: '1px 7px', whiteSpace: 'nowrap' }}>This account</span>}
        {m.plan && <span style={{ font: '400 10.5px var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-pill)', padding: '1px 7px' }}>{m.plan}</span>}
        <span title={m.stale ? 'These figures are old: no thread has reported in a while' : undefined}
          style={{ marginLeft: 'auto', font: '400 11px var(--font-mono)', color: m.stale ? 'var(--color-status-yellow)' : 'var(--color-text-tertiary)' }}>{m.asOf}</span>
      </div>
      {rows.map((r, i) => <LimitRow key={r.type} toolName={m.name} row={r} warn={warn} first={i === 0} />)}
      {/* Money and credits (2026-11-06): Claude's extra-usage spend this month, Codex's prepaid balance. */}
      {(m.spend || m.creditBalance) && (
        <div data-testid="usage-money" style={{ borderTop: rows.length ? '1px solid var(--color-border)' : 'none', padding: '11px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {m.spend && <div style={{ fontSize: 13.5, color: 'var(--color-text-secondary)' }}>{m.spend}</div>}
          {m.creditBalance && <div style={{ fontSize: 13.5, color: 'var(--color-text-secondary)' }}>{m.creditBalance}</div>}
        </div>
      )}
      {m.credits > 0 && (
        <div style={{ borderTop: '1px solid var(--color-border)', padding: '11px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{m.credits}</span>
            <span style={{ fontSize: 14 }}>reset{m.credits === 1 ? '' : 's'} banked</span>
            {/* A reset is used on the ChatGPT usage page (2026-11-06). Codex's own app-server refuses the
                in-app spend until a limit is hit ("nothingToReset"), so the link is the way that works. */}
            {m.useUrl && (
              <a href={m.useUrl} target="_blank" rel="noopener noreferrer" aria-label={`Use a reset on the ${m.name} usage page`}
                style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 500, textDecoration: 'none' }}>
                Use<ArrowSquareOut size={13} weight="bold" />
              </a>
            )}
          </div>
          {m.creditList.length > 0 && (
            <div data-testid="reset-expiries" style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
              Expire{' '}
              {m.creditList.map((c, i) => (
                <span key={c.id} style={{ color: c.soon ? 'var(--color-status-yellow)' : undefined }}>{i > 0 ? ' · ' : ''}{c.expires ?? 'never'}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** `current` (opened from a thread, 2026-11-07): that thread's account is marked "This account" and listed first. */
export function UsageRings({ summary, now, current }: { summary: UsageSummary | null; now: number; current?: { provider: string; accountId: string } | null }) {
  const isCurrent = (m: RingModel) => !!current && m.provider === current.provider && m.accountId === current.accountId;
  const rings = [...ringModels(summary, now)].sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)));
  if (!summary || (rings.length === 0 && summary.paused.length === 0)) return <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>No figures reported yet</div>;
  return (
    <div data-testid="usage-rings" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* A pause can come before any figure (a paused Codex with no snapshot): its line still shows. */}
      {rings.length === 0 && <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>No figures reported yet</div>}
      {rings.map((m) => (
        <ToolCard key={`${m.provider}|${m.accountId}`} m={m} warn={summary.warnPercent} current={isCurrent(m)} />
      ))}
      {summary.paused.map((g) => (
        <div key={g.provider} style={{ fontSize: 12, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>{bannerText(g, now)}</div>
      ))}
    </div>
  );
}
