import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useAnalyticsFeed } from '../../stores/analytics';
import { useProjects } from '../../stores/projects';
import { useIsMobile } from '../../hooks/useIsMobile';
import { inputStyle, muted, normKey, startOfLocalDay } from './parts';
import { UsageAnalytics } from './UsageAnalytics';
import { ControlPlaneAnalytics } from './ControlPlaneAnalytics';
import type { AnalyticsPoint } from '../../api/types';

type RangeId = '7' | '30' | '90' | 'all';
const RANGES: { id: RangeId; label: string; days: number | null }[] = [
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '30', label: 'Last 30 days', days: 30 },
  { id: '90', label: 'Last 90 days', days: 90 },
  { id: 'all', label: 'All time', days: null },
];

/** The two views of one screen (spec 2026-09-29-control-plane-analytics-design.md, section 3). */
export type AnalyticsTab = 'usage' | 'control-plane';
export const ANALYTICS_TAB_KEY = 'dispatch:analytics-view';

/** The view the reader chose last. A first visit, or an unknown stored value, opens Usage. */
export function loadAnalyticsTab(): AnalyticsTab {
  try {
    return localStorage.getItem(ANALYTICS_TAB_KEY) === 'control-plane' ? 'control-plane' : 'usage';
  } catch {
    return 'usage';
  }
}

function saveAnalyticsTab(tab: AnalyticsTab): void {
  try { localStorage.setItem(ANALYTICS_TAB_KEY, tab); } catch { /* ignore */ }
}

/**
 * The Analytics screen: the title, the view switch, and the filter row, which both views share.
 * A change of view never moves or resets a filter, because the filters live here, above both views.
 */
export function AnalyticsView() {
  const isMobile = useIsMobile();
  const sessions = useProjects((s) => s.sessions);
  const [tab, setTab] = useState<AnalyticsTab>(loadAnalyticsTab);
  const [rangeId, setRangeId] = useState<RangeId>('30');
  const [projectId, setProjectId] = useState('');
  const [provider, setProvider] = useState('');
  const [providerOptions, setProviderOptions] = useState<AnalyticsPoint[]>([]);
  const rev = useAnalyticsFeed((s) => s.rev);

  const days = RANGES.find((r) => r.id === rangeId)?.days ?? null;
  const from = days == null ? undefined : startOfLocalDay(days - 1).toISOString();

  // The provider list is fetched WITHOUT the provider filter, so the select always offers every
  // provider in the range — a filtered list would strand the reader on one. It follows the live
  // revision and re-runs after a pick, so the list stays current in both views.
  useEffect(() => {
    let cancelled = false;
    api.analyticsSeries({ ...(from ? { from } : {}), ...(projectId ? { projectId } : {}), metric: 'tokens', groupBy: 'provider' })
      .then((points) => { if (!cancelled) setProviderOptions(points); })
      .catch(() => { /* keep the last list; each view reports its own errors */ });
    return () => { cancelled = true; };
  }, [from, projectId, provider, rev]);

  const providerDomain = useMemo(
    () => [...new Set(providerOptions.map((p) => normKey(p.key)))].sort(),
    [providerOptions],
  );

  const choose = (next: AnalyticsTab) => { saveAnalyticsTab(next); setTab(next); };
  const filtered = Boolean(projectId) || Boolean(provider) || rangeId !== '30';

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: isMobile ? 14 : 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 20, fontWeight: 600 }}>Analytics</span>
        {!isMobile && <ViewSwitch value={tab} onChange={choose} />}
        <span style={{ ...muted, font: '400 11px var(--font-mono)' }}>days are local time</span>
      </div>
      {isMobile && (
        <div style={{ marginTop: 12 }}>
          <ViewSwitch value={tab} onChange={choose} fullWidth />
        </div>
      )}

      {/* The filter row: the same controls, in the same place, with the same values in both views. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0 16px' }}>
        <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={inputStyle}>
          <option value="">All projects</option>
          {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select aria-label="Range" value={rangeId} onChange={(e) => setRangeId(e.target.value as RangeId)} style={inputStyle}>
          {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)} style={inputStyle}>
          <option value="">All providers</option>
          {providerDomain.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {tab === 'usage'
        ? <UsageAnalytics from={from} projectId={projectId} provider={provider} filtered={filtered} />
        : <ControlPlaneAnalytics from={from} projectId={projectId} provider={provider} />}
    </div>
  );
}

/** A segmented control, not document tabs: one screen with two views (spec section 3). */
function ViewSwitch({ value, onChange, fullWidth }: {
  value: AnalyticsTab; onChange: (tab: AnalyticsTab) => void; fullWidth?: boolean;
}) {
  const options: { id: AnalyticsTab; label: string }[] = [
    { id: 'usage', label: 'Usage' },
    { id: 'control-plane', label: 'Control Plane' },
  ];
  return (
    <div
      role="group"
      aria-label="Analytics view"
      style={{
        display: fullWidth ? 'flex' : 'inline-flex', gap: 2, padding: 2,
        background: 'var(--color-base)', border: '1px solid var(--color-border)', borderRadius: 8,
      }}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.id)}
            style={{
              flex: fullWidth ? 1 : undefined, height: 26, padding: '0 12px', border: 'none', borderRadius: 6,
              cursor: 'pointer', fontSize: 12, fontWeight: active ? 600 : 400,
              background: active ? 'var(--color-hover)' : 'transparent',
              color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
