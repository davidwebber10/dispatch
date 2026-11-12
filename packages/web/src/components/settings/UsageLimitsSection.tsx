import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { UsageLimitSettings, UsageSummary } from '../../api/types';
import { useSettings } from '../../stores/settings';
import { useUsageLimits } from '../../stores/usageLimits';
import { useNow } from '../../hooks/useNow';
import { useIsMobile } from '../../hooks/useIsMobile';
import { TYPE_LABEL, HIDDEN_TYPES, whenLabel, windowLabel } from '../inspector/usageLimits';
import { liveValue, entryName, ringTone, bannerText, RING_COLOR, CLI_NOTE, STALE_MS, type RingTone } from '../layout/usageGauge';
import { Segmented } from '../common/Segmented';
import { row, item, Toggle, SettingsPage, SettingsGroup, SettingsRow, EmptyState, ToneDot, sectionLabel } from './ui';
import { fontVar, fontVarInput } from '../../lib/fontSize';

export const WARN_MIN = 50;
export const WARN_MAX = 99;
const STEP = 5;
const note: React.CSSProperties = { fontSize: fontVar(11.5), color: 'var(--color-text-tertiary)' };

/** Round, then clamp to 50..99, the same rule the daemon applies. */
export function clampWarn(n: number): number { return Math.min(WARN_MAX, Math.max(WARN_MIN, Math.round(n))); }

/**
 * The daemon-wide usage limit settings (#127): the warning threshold and the push alert. Every device sees
 * the same; the daemon sends the push. Used by Settings > Usage limits (the threshold) and Settings >
 * Notifications (the push alert); each keeps its own copy and follows the daemon's broadcasts.
 * A failed PUT rolls the row back to what the daemon last confirmed.
 */
export function useUsageLimitSettings() {
  const [cfg, setCfg] = useState<UsageLimitSettings | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const summary = useUsageLimits((s) => s.summary);
  // One settings state, three writers: the first GET, a broadcast from the daemon (another device changed
  // something), and this device's own saves. `rev` counts every write that took effect. A GET or a PUT
  // remembers the count when it started and installs its answer only if no later write happened meanwhile.
  const rev = useRef(0);
  const install = (s: UsageLimitSettings) => { rev.current++; setCfg(s); setDraft(String(s.warnPercent)); };

  useEffect(() => {
    const started = rev.current;
    let alive = true;
    api.getUsageLimitSettings()
      .then((s) => { if (alive && rev.current === started) install(s); })
      .catch(() => { if (alive && rev.current === started) setErr('Could not load the usage limit settings.'); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Another device changed the threshold or the push switch: the broadcast carries both, and builds the state
  // when the GET has not answered yet. An older daemon sends no push switch: then only the threshold follows.
  useEffect(() => {
    if (!summary) return;
    if (summary.pushOnWarn !== undefined) { install({ warnPercent: summary.warnPercent, pushOnWarn: summary.pushOnWarn }); return; }
    if (cfg && summary.warnPercent !== cfg.warnPercent) install({ ...cfg, warnPercent: summary.warnPercent });
  }, [summary?.warnPercent, summary?.pushOnWarn]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (patch: Partial<UsageLimitSettings>) => {
    if (!cfg) return;
    const prior = cfg;
    install({ ...cfg, ...patch });
    const started = rev.current;
    setErr(null);
    api.setUsageLimitSettings(patch)
      .then((s) => { if (rev.current === started) install(s); })
      .catch(() => {
        setErr('Could not save. The daemon kept the old value.');
        if (rev.current === started) install(prior); // a newer write (a broadcast, another save) already replaced what this one showed
      });
  };
  return { cfg, draft, setDraft, err, save, summary };
}

/** Settings > Notifications: the push sent when a usage window reaches the warning level. All devices. */
export function UsageAlertSetting() {
  const { cfg, err, save } = useUsageLimitSettings();
  return (
    <>
      {cfg && (
        <>
          <div style={row}>
            <span style={item}>Push alert at the usage warning level</span>
            <Toggle on={cfg.pushOnWarn} onClick={() => save({ pushOnWarn: !cfg.pushOnWarn })} label="Push alert at the warning level" />
          </div>
          <div style={note}>One push per limit window when a 5-hour or weekly window reaches {cfg.warnPercent}% (set in Usage limits), to every device with notifications on.</div>
        </>
      )}
      {err && <div role="alert" style={{ fontSize: fontVar(11.5), color: 'var(--color-status-red)' }}>{err}</div>}
    </>
  );
}

/**
 * Settings > Usage limits (#127), laid out 2026-11-07 (docs/design/settings-layout.md): the warning
 * level (all devices), what this device shows (the paused banner, the phone header's rings, the
 * ring's middle), and the current figures, one card per account with a meter per limit window.
 */
export function UsageLimitsSection() {
  const { cfg, draft, setDraft, err, save, summary } = useUsageLimitSettings();
  const showBanner = useSettings((s) => s.showUsageBanner);
  const ringCenter = useSettings((s) => s.usageRingCenter);
  const phoneHeader = useSettings((s) => s.phoneHeaderUsage);
  const now = useNow();
  const setWarn = (n: number) => { if (cfg && Number.isFinite(n)) { const v = clampWarn(n); if (v !== cfg.warnPercent) save({ warnPercent: v }); else setDraft(String(v)); } };
  const commitDraft = () => { const n = Number(draft); if (draft.trim() === '' || !Number.isFinite(n)) { if (cfg) setDraft(String(cfg.warnPercent)); return; } setWarn(n); };

  return (
    <SettingsPage>
      <SettingsGroup title="Warning" footer={err ? <span role="alert" style={{ color: 'var(--color-status-red)' }}>{err}</span> : 'The same on every device. The push alert at this level is in Notifications.'}>
        <SettingsRow label="Warn at" hint="A 5-hour or weekly limit at this level turns its ring red. 50 to 99."
          control={cfg ? (
            <PercentStepper draft={draft} setDraft={setDraft} onCommit={commitDraft}
              onDec={() => setWarn(cfg.warnPercent - STEP)} onInc={() => setWarn(cfg.warnPercent + STEP)} />
          ) : <span style={{ fontSize: fontVar(12.5), color: 'var(--color-text-tertiary)' }}>Loading…</span>} />
      </SettingsGroup>

      <SettingsGroup title="This device">
        <SettingsRow label="Paused banner" hint="The red banner while agents wait on a usage limit."
          control={<Toggle on={showBanner} onClick={() => useSettings.getState().setShowUsageBanner(!showBanner)} label="Show the paused banner on this device" />} />
        <SettingsRow label="All accounts in the phone header" hint="Outside a thread. A thread shows the ring of its own account."
          control={<Toggle on={phoneHeader} onClick={() => useSettings.getState().setPhoneHeaderUsage(!phoneHeader)} label="All accounts in the phone header" />} />
        <SettingsRow label="In the usage ring" hint="The ring fills with the 5-hour and weekly limits, and a model's own weekly limit in a thread on that model.">
          <Segmented ariaLabel="In the usage ring" value={ringCenter}
            options={[{ value: 'logo', label: 'Logo' }, { value: 'percent', label: 'Percent used' }]}
            onChange={(v) => useSettings.getState().setUsageRingCenter(v as 'logo' | 'percent')} />
        </SettingsRow>
      </SettingsGroup>

      <UsageFigures summary={summary} now={now} />
    </SettingsPage>
  );
}

/** The warning level: − and + by 5, or type a number (clamped on blur or Enter). */
function PercentStepper({ draft, setDraft, onCommit, onDec, onInc }: { draft: string; setDraft: (v: string) => void; onCommit: () => void; onDec: () => void; onInc: () => void }) {
  const lg = useIsMobile();
  const h = lg ? 34 : 28;
  const btn = (side: 'l' | 'r'): React.CSSProperties => ({ width: h, height: h, padding: 0, background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: side === 'l' ? 'var(--radius-sm) 0 0 var(--radius-sm)' : '0 var(--radius-sm) var(--radius-sm) 0', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: `500 ${fontVar(15)} var(--font-sans)` });
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <button type="button" aria-label="Lower the warning level" onClick={onDec} style={btn('l')}>−</button>
      <span style={{ position: 'relative', display: 'flex' }}>
        <input aria-label="Warning level percent" inputMode="numeric" value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ''))}
          onBlur={onCommit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={{ width: lg ? 'max(64px, 4rem)' : 'max(58px, 3.625rem)', height: h, boxSizing: 'border-box', padding: '0 max(16px, 1rem) 0 4px', textAlign: 'center', background: 'var(--color-elevated)', border: 'none', borderTop: '1px solid var(--color-border-strong)', borderBottom: '1px solid var(--color-border-strong)', borderRadius: 0, color: 'var(--color-text-primary)', font: `500 ${lg ? fontVarInput(16) : fontVar(13)} var(--font-sans)` }} />
        <span aria-hidden style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: fontVar(lg ? 14 : 12), color: 'var(--color-text-tertiary)', pointerEvents: 'none' }}>%</span>
      </span>
      <button type="button" aria-label="Raise the warning level" onClick={onInc} style={btn('r')}>+</button>
    </div>
  );
}

interface FigureRow { type: string; label: string; used: number | null; tone: RingTone; note: string }
interface FigureCard { key: string; name: string; plan?: string; asOf: string; stale: boolean; rows: FigureRow[] }

/** Every account's windows in the same order as the popover table (UsageTable): known types first, then the rest. */
function figureCards(s: UsageSummary, now: number): FigureCard[] {
  return s.providers.map((p) => {
    const known = Object.keys(TYPE_LABEL).filter((t) => p.windows[t] && !HIDDEN_TYPES.has(t));
    const unknown = Object.keys(p.windows).filter((t) => !(t in TYPE_LABEL)).sort();
    const rows = [...known, ...unknown].map((t): FigureRow => {
      const w = p.windows[t];
      const used = liveValue(w, now);
      const note = used === null ? windowLabel(w, now)
        : w.resetsAt !== null ? `Resets ${whenLabel(w.resetsAt, now)}` : 'No reset time reported';
      return { type: t, label: TYPE_LABEL[t] ?? t, used, tone: used === null ? 'green' : ringTone(used, s.warnPercent), note };
    });
    return { key: `${p.provider}|${p.accountId ?? 'cli'}`, name: entryName(p, s.providers), plan: p.plan, asOf: whenLabel(p.asOf, now), stale: now - p.asOf > STALE_MS, rows };
  });
}

const card: React.CSSProperties = { background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)' };

/**
 * The current figures: one card per account (name, plan, when the figures are from), a meter row per
 * limit window colored like the rings, any pause above them, and an empty state before any report.
 * A local stack of cards under one group label: SettingsGroup holds one card.
 */
function UsageFigures({ summary, now }: { summary: UsageSummary | null; now: number }) {
  const cards = summary ? figureCards(summary, now) : [];
  const paused = summary?.paused ?? [];
  return (
    <section role="group" aria-label="Current figures" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 22, padding: '0 4px' }}>
        <span style={{ ...sectionLabel, textTransform: 'uppercase' }}>Current figures</span>
      </div>
      {paused.map((g) => (
        <div key={g.provider} role="status" style={{ ...card, display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderColor: 'var(--color-status-red)', fontSize: fontVar(13), lineHeight: 1.4, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>
          <span style={{ paddingTop: 5 }}><ToneDot tone="red" /></span>{bannerText(g, now)}
        </div>
      ))}
      {cards.length === 0 ? (
        <EmptyState>No figures reported yet. {CLI_NOTE}</EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {cards.map((c) => (
            <div key={c.key} data-testid="usage-account" style={card}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '11px 12px', minWidth: 0 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ fontSize: fontVar(13.5), fontWeight: 600, color: 'var(--color-text-primary)' }}>{c.name}</span>
                  {c.plan && <span style={{ marginLeft: 8, fontSize: fontVar(12), color: 'var(--color-text-tertiary)' }}>{c.plan}</span>}
                </span>
                <span title={c.stale ? 'Only Pretty threads and Chat report usage, so this figure can be old.' : undefined}
                  style={{ flexShrink: 0, fontSize: fontVar(12), color: c.stale ? 'var(--color-status-yellow)' : 'var(--color-text-tertiary)' }}>As of {c.asOf}</span>
              </div>
              {c.rows.length === 0 && <div style={{ borderTop: '1px solid var(--color-border)', padding: '11px 12px', fontSize: fontVar(12.5), color: 'var(--color-text-tertiary)' }}>No limits reported</div>}
              {c.rows.map((r) => <MeterRow key={r.type} row={r} />)}
            </div>
          ))}
        </div>
      )}
      {cards.length > 0 && <div style={{ padding: '0 4px', fontSize: fontVar(11.5), lineHeight: 1.5, color: 'var(--color-text-tertiary)' }}>{CLI_NOTE}</div>}
    </section>
  );
}

/** One limit window: its name and percent, a bar in the ring's color, and when it resets. */
function MeterRow({ row: r }: { row: FigureRow }) {
  const color = RING_COLOR[r.tone];
  return (
    <div style={{ borderTop: '1px solid var(--color-border)', padding: '10px 12px 11px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: fontVar(13), color: 'var(--color-text-secondary)' }}>{r.label}</span>
        <span style={{ fontSize: fontVar(13), fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: r.used === null ? 'var(--color-text-tertiary)' : r.tone === 'green' ? 'var(--color-text-primary)' : color }}>
          {r.used === null ? '–' : `${r.used}%`}
        </span>
      </div>
      <div role="meter" aria-label={r.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.used ?? undefined} data-tone={r.tone}
        style={{ height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--color-hover)', overflow: 'hidden' }}>
        {r.used !== null && r.used > 0 && <div style={{ width: `${Math.min(100, r.used)}%`, height: '100%', borderRadius: 'var(--radius-pill)', background: color }} />}
      </div>
      <span style={{ fontSize: fontVar(12), color: 'var(--color-text-tertiary)' }}>{r.note}</span>
    </div>
  );
}
