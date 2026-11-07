import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { UsageLimitSettings } from '../../api/types';
import { useSettings } from '../../stores/settings';
import { useUsageLimits } from '../../stores/usageLimits';
import { useNow } from '../../hooks/useNow';
import { UsageTable } from '../layout/UsageChip';
import { sectionLabel, row, item, Divider, Toggle } from './ui';

export const WARN_MIN = 50;
export const WARN_MAX = 99;
const STEP = 5;
const note: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)' };

/** Round, then clamp to 50..99, the same rule the daemon applies. */
export function clampWarn(n: number): number { return Math.min(WARN_MAX, Math.max(WARN_MIN, Math.round(n))); }

/**
 * The daemon-wide usage limit settings (#127): the warning threshold and the push alert. Every device sees
 * the same; the daemon sends the push. Used by Settings > Usage limits (the threshold) and Settings >
 * Notifications (the push alert); each keeps its own copy and follows the daemon's broadcasts.
 * A failed PUT rolls the row back to what the daemon last confirmed.
 */
function useUsageLimitSettings() {
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
      {err && <div role="alert" style={{ fontSize: 11.5, color: 'var(--color-status-red)' }}>{err}</div>}
    </>
  );
}

/** Settings > Usage limits (#127): the threshold (all devices), the paused banner (this device), the figures. */
export function UsageLimitsSection() {
  const { cfg, draft, setDraft, err, save, summary } = useUsageLimitSettings();
  const showBanner = useSettings((s) => s.showUsageBanner);
  const ringCenter = useSettings((s) => s.usageRingCenter);
  const now = useNow();
  const setWarn = (n: number) => { if (cfg && Number.isFinite(n)) { const v = clampWarn(n); if (v !== cfg.warnPercent) save({ warnPercent: v }); else setDraft(String(v)); } };
  const commitDraft = () => { const n = Number(draft); if (draft.trim() === '' || !Number.isFinite(n)) { if (cfg) setDraft(String(cfg.warnPercent)); return; } setWarn(n); };
  const btn = (side: 'l' | 'r'): React.CSSProperties => ({ width: 28, height: 28, background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: side === 'l' ? 'var(--radius-sm) 0 0 var(--radius-sm)' : '0 var(--radius-sm) var(--radius-sm) 0', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '500 14px var(--font-sans)' });

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={sectionLabel}>ALL DEVICES</span>
        {cfg && (
          <>
            <div style={row}>
              <span style={item}>Warn at</span>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button type="button" aria-label="Lower the warning level" onClick={() => setWarn(cfg.warnPercent - STEP)} style={btn('l')}>−</button>
                <input aria-label="Warning level percent" inputMode="numeric" value={draft}
                  onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ''))}
                  onBlur={commitDraft}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  style={{ width: 52, height: 28, boxSizing: 'border-box', textAlign: 'center', background: 'var(--color-elevated)', border: 'none', borderTop: '1px solid var(--color-border-strong)', borderBottom: '1px solid var(--color-border-strong)', color: 'var(--color-text-body)', font: '400 12px var(--font-mono)' }} />
                <button type="button" aria-label="Raise the warning level" onClick={() => setWarn(cfg.warnPercent + STEP)} style={btn('r')}>+</button>
                <span style={{ marginLeft: 6, font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>%</span>
              </div>
            </div>
            <div style={note}>The chip turns amber when a 5-hour or weekly window reaches this level. 50 to 99. The push alert at this level is in Notifications.</div>
          </>
        )}
        {err && <div role="alert" style={{ fontSize: 11.5, color: 'var(--color-status-red)' }}>{err}</div>}
      </div>
      <Divider />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={sectionLabel}>THIS DEVICE</span>
        <div style={row}>
          <span style={item}>Show the paused banner on this device</span>
          <Toggle on={showBanner} onClick={() => useSettings.getState().setShowUsageBanner(!showBanner)} label="Show the paused banner on this device" />
        </div>
        <div style={note}>The red banner shown while agents are paused on a usage limit.</div>
        <div style={row}>
          <span style={item}>In the usage ring</span>
          <div role="radiogroup" aria-label="In the usage ring" style={{ display: 'inline-flex', padding: 2, gap: 2, borderRadius: 'var(--radius-md)', background: 'var(--color-hover)' }}>
            {([['logo', 'Logo'], ['percent', 'Percent used']] as const).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={ringCenter === v} onClick={() => useSettings.getState().setUsageRingCenter(v)}
                style={{ height: 28, padding: '0 10px', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12.5, fontWeight: 500,
                  background: ringCenter === v ? 'var(--color-elevated)' : 'transparent', color: ringCenter === v ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>{label}</button>
            ))}
          </div>
        </div>
        <div style={note}>The ring counts the 5-hour and weekly limits, and a model's own weekly limit in a thread on that model.</div>
      </div>
      <Divider />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={sectionLabel}>CURRENT FIGURES</span>
        <UsageTable summary={summary} now={now} />
      </div>
    </>
  );
}
