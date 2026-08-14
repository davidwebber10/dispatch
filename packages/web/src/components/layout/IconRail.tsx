import { useState } from 'react';
import { ChartBar, Gear, Kanban, Rows, Sidebar } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { BrandSwitcher } from './BrandSwitcher';
import { SettingsModal } from '../settings/SettingsModal';
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

function SmallBtn({ title, onClick, active, children }: {
  title: string; onClick: () => void; active?: boolean; children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" title={title} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: 26, height: 26, flexShrink: 0, borderRadius: 7, border: 'none', cursor: 'pointer', padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hover ? 'var(--color-elevated)' : 'transparent',
        color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
      }}>
      {children}
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
  const [settings, setSettings] = useState(false);
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const leftCollapsed = useUI((s) => s.leftCollapsed);
  const rightCollapsed = useUI((s) => s.rightCollapsed);
  const status = useConnection((s) => s.status);
  const servers = useServers((s) => s.servers);
  const conn = CONN[status];
  const serverLabel = currentLabel(servers, window.location.origin);

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
      <div style={{ display: 'flex', gap: 4 }}>
        <SmallBtn title={leftCollapsed ? 'Show projects panel' : 'Hide projects panel'}
          active={!leftCollapsed} onClick={() => useUI.getState().toggleLeft()}>
          <Sidebar size={15} weight={leftCollapsed ? 'regular' : 'fill'} />
        </SmallBtn>
        <SmallBtn title={rightCollapsed ? 'Show details panel' : 'Hide details panel'}
          active={!rightCollapsed} onClick={() => useUI.getState().toggleRight()}>
          <Sidebar size={15} weight={rightCollapsed ? 'regular' : 'fill'} style={{ transform: 'scaleX(-1)' }} />
        </SmallBtn>
      </div>
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
      <SmallBtn title="Settings" onClick={() => setSettings(true)}>
        <Gear size={16} />
      </SmallBtn>
      <SettingsModal open={settings} onClose={() => setSettings(false)} />
    </nav>
  );
}
