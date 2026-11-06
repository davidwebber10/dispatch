import { useEffect, useRef, useState } from 'react';
import { ArrowCounterClockwise } from '@phosphor-icons/react';
import type { UsageSummary } from '../../api/types';
import { api } from '../../api/client';
import { ConfirmModal } from '../common/ConfirmModal';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { ringModels, RING_COLOR, yellowFrom, bannerText, type RingModel, type RingRow } from './usageGauge';

/**
 * The usage sheet (2026-11-05): one full-width card per tool. The ring shows what is LEFT of one
 * limit, so it empties as you use it; the big number in it says how much is USED. Green, then
 * yellow, then red, with a tick where each colour starts. A tool with more than one limit lists
 * them all; tapping one puts it in the ring (the closest-to-empty is there first). On opening, and
 * on every switch, the ring sweeps into place and the number counts up.
 */
const R = 40;
const C = 2 * Math.PI * R;
const ANIM_MS = 700;
const pointAt = (leftPct: number, r: number) => {
  const a = (leftPct / 100) * 2 * Math.PI - Math.PI / 2; // 0% at the top, clockwise
  return [52 + r * Math.cos(a), 52 + r * Math.sin(a)];
};

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

function Ring({ name, row, used, warn }: { name: string; row: RingRow; used: number; warn: number }) {
  const left = Math.max(0, 100 - used);
  const color = RING_COLOR[row.tone];
  // Where the colour changes, in "left" terms: yellow starts at 100 - yellowFrom, red at 100 - warn.
  const ticks: [number, string][] = [[100 - yellowFrom(warn), RING_COLOR.yellow], [100 - warn, RING_COLOR.red]];
  const target = 100 - (row.left ?? 0);
  return (
    <svg width={104} height={104} viewBox="0 0 104 104" role="img" aria-label={`${name}: ${target}% of ${row.label} used, ${row.left}% left`}>
      <circle cx={52} cy={52} r={R} fill="none" stroke="var(--color-hover)" strokeWidth={9} />
      {left > 0.3 && (
        <circle cx={52} cy={52} r={R} fill="none" stroke={color} strokeWidth={9} strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - left / 100)} transform="rotate(-90 52 52)" />
      )}
      {ticks.map(([t, c]) => {
        const [x1, y1] = pointAt(t, R + 6.5);
        const [x2, y2] = pointAt(t, R + 11);
        return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={2.5} strokeLinecap="round" />;
      })}
    </svg>
  );
}

function ToolCard({ m, warn, onUseCredit, note }: { m: RingModel; warn: number; onUseCredit: (m: RingModel) => void; note: { ok: boolean; text: string } | null }) {
  const reduced = usePrefersReducedMotion();
  const [picked, setPicked] = useState<string | null>(null);
  const row = m.rows.find((r) => r.type === picked) ?? m.main;
  const used = useAnimatedUsed(100 - (row.left ?? 0), reduced);
  const many = m.rows.length > 1;
  return (
    <section aria-label={m.name} style={{ background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 12, display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 18, fontWeight: 600 }}>{m.name}</span>
          {m.plan && <span style={{ font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{m.plan}</span>}
        </div>
        {m.rows.map((r) => {
          const on = r.type === row.type;
          const body = (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 13 }}>
                <span style={{ color: on && many ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', fontWeight: on && many ? 600 : 400 }}>{r.label}</span>
                {/* The limit in the ring has its number there: no second copy on its row. */}
                {!on && <span style={{ font: '600 13px var(--font-mono)', color: r.tone === 'green' ? 'var(--color-text-primary)' : RING_COLOR[r.tone] }}>{100 - (r.left ?? 0)}%</span>}
              </div>
              {(r.reset || r.estimate) && (
                <div title={r.estimateTitle ?? undefined} style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                  {r.reset}{r.reset && r.estimate ? ' · ' : ''}{r.estimate}{r.estimate && <span style={{ marginLeft: 4, font: '600 9px var(--font-mono)', letterSpacing: '.06em', padding: '0 4px', borderRadius: 'var(--radius-xs)', border: '1px solid var(--color-border)' }}>EST</span>}
                </div>
              )}
            </>
          );
          // With one limit there is nothing to pick: a plain row. With several, each is a button.
          return many ? (
            <button key={r.type} type="button" aria-pressed={on} onClick={() => setPicked(r.type)}
              style={{ display: 'block', width: 'calc(100% + 16px)', textAlign: 'left', lineHeight: 1.35, margin: '0 -8px', padding: '5px 8px', boxSizing: 'border-box', background: on ? 'var(--color-hover)' : 'transparent', border: 'none', borderRadius: 'var(--radius-md)', color: 'inherit', cursor: 'pointer', font: 'inherit' }}>
              {body}
            </button>
          ) : <div key={r.type} style={{ lineHeight: 1.35 }}>{body}</div>;
        })}
        {m.credits > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
            {/* "Use one" spends the reset that expires soonest, so none lapses unused. */}
            <button type="button" onClick={() => onUseCredit(m)}
              style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 12, cursor: 'pointer' }}>
              <ArrowCounterClockwise size={13} weight="bold" />
              {m.credits} reset{m.credits === 1 ? '' : 's'} banked · Use one
            </button>
            {m.creditList.length > 0 && (
              <div data-testid="reset-expiries" style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
                Expire{' '}
                {m.creditList.map((c, i) => (
                  <span key={c.id} style={{ color: c.soon ? 'var(--color-status-yellow)' : undefined }}>{i > 0 ? ' · ' : ''}{c.expires ?? 'never'}</span>
                ))}
              </div>
            )}
          </div>
        )}
        {note && <div role="status" style={{ fontSize: 11.5, color: note.ok ? 'var(--color-accent)' : 'var(--color-status-red)' }}>{note.text}</div>}
        {m.stale && <div style={{ font: '400 10.5px var(--font-mono)', color: 'var(--color-status-yellow)' }}>{m.asOf}</div>}
      </div>
      <div style={{ position: 'relative', width: 104, height: 104, flex: 'none', opacity: m.stale ? 0.55 : 1 }}>
        <Ring name={m.name} row={row} used={used} warn={warn} />
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ font: '700 24px var(--font-mono)', color: row.tone === 'green' ? 'var(--color-text-primary)' : RING_COLOR[row.tone] }}>{Math.round(used)}%</span>
          <span style={{ fontSize: 10.5, color: 'var(--color-text-secondary)' }}>{row.label} used</span>
        </div>
      </div>
    </section>
  );
}

const OUTCOME: Record<string, [boolean, string]> = {
  reset: [true, 'Reset used: the limit is back to zero.'],
  nothingToReset: [false, 'Nothing to reset yet: no credit was spent.'],
  noCredit: [false, 'No banked resets left.'],
  alreadyRedeemed: [false, 'That reset was already used.'],
};

export function UsageRings({ summary, now }: { summary: UsageSummary | null; now: number }) {
  const rings = ringModels(summary, now);
  // Spending a banked reset is the account's to spend: confirm first, then say what happened.
  const [confirmFor, setConfirmFor] = useState<RingModel | null>(null);
  const [creditNote, setCreditNote] = useState<{ provider: string; ok: boolean; text: string } | null>(null);
  const onUseCredit = (m: RingModel) => { setCreditNote(null); setConfirmFor(m); };
  const spend = async () => {
    const m = confirmFor;
    setConfirmFor(null);
    if (!m) return;
    try {
      const { outcome } = await api.useResetCredit(m.provider, m.creditList[0]?.id);
      const [ok, text] = OUTCOME[outcome] ?? [false, `Codex answered: ${outcome}`];
      setCreditNote({ provider: m.provider, ok, text });
    } catch (e) {
      setCreditNote({ provider: m.provider, ok: false, text: e instanceof Error ? e.message : 'Could not use a reset' });
    }
  };
  if (!summary || rings.length === 0) return <div style={{ fontSize: 13, color: 'var(--color-text-tertiary)', padding: '8px 0' }}>No figures reported yet</div>;
  return (
    <div data-testid="usage-rings" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rings.map((m) => (
        <ToolCard key={m.provider} m={m} warn={summary.warnPercent} onUseCredit={onUseCredit}
          note={creditNote?.provider === m.provider ? creditNote : null} />
      ))}
      <ConfirmModal
        open={!!confirmFor}
        title="Use a banked reset?"
        message={confirmFor ? `This spends 1 of ${confirmFor.name}'s ${confirmFor.credits} banked resets${confirmFor.creditList[0]?.expires ? `, the one expiring ${confirmFor.creditList[0].expires}` : ''}, and sets its limit back to zero.` : ''}
        confirmLabel="Use one"
        onConfirm={() => void spend()}
        onCancel={() => setConfirmFor(null)}
      />
      {summary.paused.map((g) => (
        <div key={g.provider} style={{ fontSize: 12, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>{bannerText(g, now)}</div>
      ))}
    </div>
  );
}
