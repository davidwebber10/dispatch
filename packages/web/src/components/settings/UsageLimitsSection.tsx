import { useEffect, useState } from 'react';
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
 * Settings > Usage limits (#127). The threshold and the push are daemon-wide (every device sees
 * the same, the daemon sends the push). The paused banner switch is this device only.
 * A failed PUT rolls the row back to what the daemon last confirmed.
 */
export function UsageLimitsSection() {
  const [cfg, setCfg] = useState<UsageLimitSettings | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const showBanner = useSettings((s) => s.showUsageBanner);
  const summary = useUsageLimits((s) => s.summary);
  const now = useNow();

  useEffect(() => {
    api.getUsageLimitSettings().then((s) => { setCfg(s); setDraft(String(s.warnPercent)); }).catch(() => setErr('Could not load the usage limit settings.'));
  }, []);
  // Another device changed the threshold: the broadcast carries it.
  useEffect(() => {
    if (summary && cfg && summary.warnPercent !== cfg.warnPercent) { setCfg((c) => c && { ...c, warnPercent: summary.warnPercent }); setDraft(String(summary.warnPercent)); }
  }, [summary?.warnPercent]); // eslint-disable-line react-hooks/exhaustive-deps
  // Another device changed the push switch: the broadcast carries it too.
  useEffect(() => {
    if (summary && cfg && summary.pushOnWarn !== undefined && summary.pushOnWarn !== cfg.pushOnWarn) { const push = summary.pushOnWarn; setCfg((c) => c && { ...c, pushOnWarn: push }); }
  }, [summary?.pushOnWarn]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (patch: Partial<UsageLimitSettings>) => {
    if (!cfg) return;
    const prior = cfg;
    const next = { ...cfg, ...patch };
    setCfg(next);
    if (patch.warnPercent !== undefined) setDraft(String(patch.warnPercent));
    setErr(null);
    api.setUsageLimitSettings(patch)
      .then((s) => { setCfg(s); setDraft(String(s.warnPercent)); })
      .catch(() => { setCfg(prior); setDraft(String(prior.warnPercent)); setErr('Could not save. The daemon kept the old value.'); });
  };
  const setWarn = (n: number) => { if (cfg && Number.isFinite(n)) { const v = clampWarn(n); if (v !== cfg.warnPercent) save({ warnPercent: v }); else setDraft(String(v)); } };
  const commitDraft = () => { const n = Number(draft); if (draft.trim() === '' || !Number.isFinite(n)) { if (cfg) setDraft(String(cfg.warnPercent)); return; } setWarn(n); };
  const btn = (side: 'l' | 'r'): React.CSSProperties => ({ width: 28, height: 28, background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: side === 'l' ? 'var(--radius-sm) 0 0 var(--radius-sm)' : '0 var(--radius-sm) var(--radius-sm) 0', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '500 14px var(--font-sans)' });

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
                  style={{ width: 52, height: 28, boxSizing: 'border-box', textAlign: 'center', background: '#1b1b1e', border: 'none', borderTop: '1px solid #2c2c32', borderBottom: '1px solid #2c2c32', color: '#c9c9cf', font: '400 12px var(--font-mono)' }} />
                <button type="button" aria-label="Raise the warning level" onClick={() => setWarn(cfg.warnPercent + STEP)} style={btn('r')}>+</button>
                <span style={{ marginLeft: 6, font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>%</span>
              </div>
            </div>
            <div style={note}>The chip turns amber when a 5-hour or weekly window reaches this level. 50 to 99.</div>
            <div style={row}>
              <span style={item}>Push alert at the warning level</span>
              <Toggle on={cfg.pushOnWarn} onClick={() => save({ pushOnWarn: !cfg.pushOnWarn })} label="Push alert at the warning level" />
            </div>
            <div style={note}>One push per limit window, to every device with notifications on.</div>
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
      </div>
      <Divider />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={sectionLabel}>CURRENT FIGURES</span>
        <UsageTable summary={summary} now={now} />
      </div>
    </>
  );
}
