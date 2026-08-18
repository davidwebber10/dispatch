import { useEffect, useState } from 'react';
import { ChartBar, Gear, Kanban, Rows } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { BrandSwitcher } from './BrandSwitcher';
import { useConnection } from '../../stores/connection';
import { useServers, currentLabel } from '../../stores/servers';
import { useUI, type View } from '../../stores/ui';

const CONN = {
  open:       { color: 'var(--color-accent)', label: 'Connected' },
  connecting: { color: 'var(--color-status-yellow)', label: 'Reconnecting…' },
  closed:     { color: 'var(--color-status-red)', label: 'Disconnected' },
} as const;

function RailItem({ icon: I, label, active, onClick, title }: {
  icon: Icon; label: string; active: boolean; onClick: () => void; title: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" title={title} aria-pressed={active} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: 52, height: 44, flexShrink: 0, borderRadius: 9, border: 'none', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
        position: 'relative', padding: 0,
        background: active ? 'rgba(62,207,106,0.10)' : hover ? 'var(--color-elevated)' : 'transparent',
        color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
      }}>
      <I size={18} weight={active ? 'fill' : 'regular'} />
      <span style={{ font: '400 8.5px var(--font-sans)', letterSpacing: '0.01em' }}>{label}</span>
      {/* Active marker: a short bar hugging the rail's left edge, like an editor activity bar. */}
      <span style={{
        position: 'absolute', left: -6, top: '50%', transform: 'translateY(-50%)',
        width: 3, height: 18, borderRadius: 2, background: active ? 'var(--color-accent)' : 'transparent',
      }} />
    </button>
  );
}

const NAV: { view: View; label: string; icon: Icon }[] = [
  { view: 'workspace', label: 'Threads', icon: Rows },
  { view: 'board', label: 'Board', icon: Kanban },
  { view: 'analytics', label: 'Analytics', icon: ChartBar },
];

/**
 * The app's primary navigation: a full-height icon rail on the far left
 * (design: "Dispatch Layout"). Replaces the old TopBar — the view switch, server
 * switcher, connection status, panel toggles, and settings all live here now.
 */
export function IconRail() {
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const status = useConnection((s) => s.status);
  const servers = useServers((s) => s.servers);
  const conn = CONN[status];
  const serverLabel = currentLabel(servers, window.location.origin);

  // ⌘, — the platform-standard preferences shortcut, now that Settings is a page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        useUI.getState().setView('settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <nav aria-label="Primary" style={{
      width: 64, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '10px 0 8px', gap: 4, background: 'var(--color-pane)', borderRight: '1px solid var(--color-border)',
    }}>
      <div style={{ marginBottom: 10 }}><BrandSwitcher /></div>
      {NAV.map((n) => (
        <RailItem key={n.view} icon={n.icon} label={n.label} title={n.label}
          active={view === n.view} onClick={() => setView(n.view)} />
      ))}
      <div style={{ flex: 1 }} />
      <div title={conn.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '6px 0 2px' }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', background: conn.color,
          boxShadow: status === 'open' ? 'var(--shadow-glow)' : undefined,
          animation: status !== 'closed' ? 'dispatchConnPulse 2s ease-in-out infinite' : undefined,
        }} />
        <span style={{ font: '500 7.5px var(--font-mono)', letterSpacing: '0.04em', color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>
          {serverLabel}
        </span>
      </div>
      <RailItem icon={Gear} label="Settings" title="Settings (⌘,)"
        active={view === 'settings'} onClick={() => setView('settings')} />
    </nav>
  );
}
