import { useState } from 'react';
import { SETTINGS_SECTIONS, settingsSection, type SettingsSectionKey } from './sections';
import { useConnection } from '../../stores/connection';
import { useServers, currentLabel } from '../../stores/servers';
import { useUpdate } from '../../stores/update';
import { useUI } from '../../stores/ui';

const CONN = {
  open:       { color: 'var(--color-accent)', label: 'Connected' },
  connecting: { color: 'var(--color-status-yellow)', label: 'Reconnecting…' },
  closed:     { color: 'var(--color-status-red)', label: 'Disconnected' },
} as const;

/**
 * Desktop settings as a full page (design: "Dispatch Settings") — a view beside
 * Threads/Board/Analytics, not a modal. Left: vertical section nav + daemon info.
 * Right: the section body. The section CONTENT components are unchanged and still
 * shared with MobileSettings, which keeps its drill-down presentation.
 */
export function SettingsView() {
  const [tab, setTab] = useState<SettingsSectionKey>('general');
  const status = useConnection((s) => s.status);
  const servers = useServers((s) => s.servers);
  const version = useUpdate((s) => s.currentVersion);
  const conn = CONN[status];
  const serverLabel = currentLabel(servers, window.location.origin);

  const active = settingsSection(tab) ?? SETTINGS_SECTIONS[0];
  const Body = active.Component;

  return (
    <div data-testid="settings-view" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden', background: 'var(--color-base)' }}>
      {/* section nav */}
      <div style={{ width: 214, flexShrink: 0, background: 'var(--color-pane)', borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 12px', borderBottom: '1px solid var(--color-border)' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>Settings</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 8px' }}>
          {SETTINGS_SECTIONS.map((s) => {
            const on = s.key === tab;
            return (
              <button key={s.key} onClick={() => setTab(s.key)} style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 8px',
                borderRadius: 7, border: 'none', cursor: 'pointer', textAlign: 'left',
                background: on ? 'rgba(62,207,106,0.10)' : 'transparent',
              }}>
                <span style={{ width: 3, height: 14, borderRadius: 2, flexShrink: 0, background: on ? 'var(--color-accent)' : 'transparent' }} />
                <span style={{ flex: 1, fontSize: 12, color: on ? 'var(--color-text-primary)' : '#b8b8c0' }}>{s.label}</span>
              </button>
            );
          })}

          <div style={{ font: '500 9.5px var(--font-mono)', letterSpacing: '0.1em', color: 'var(--color-text-tertiary)', padding: '16px 8px 6px' }}>DAEMON</div>
          <div style={{ padding: '0 8px', font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)', lineHeight: 1.7 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: conn.color, display: 'inline-block' }} />
              <span style={{ color: conn.color }}>{conn.label}</span>
              <span>· {serverLabel}</span>
            </div>
            {version && <div>v{version}</div>}
            <div>~/.dispatch</div>
          </div>
        </div>
        <div style={{ borderTop: '1px solid var(--color-border)', padding: '8px 12px', font: '400 9.5px var(--font-mono)', color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
          Changes save as you edit
        </div>
      </div>

      {/* content */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
          <span style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}>{active.label}</span>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.blurb}</span>
          <span style={{ font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>⌘, to reopen</span>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 18px 40px' }}>
          <div style={{ maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* onDone exists for the setup wizard: leave settings so the wizard isn't buried. */}
            <Body onDone={() => useUI.getState().setView('workspace')} />
          </div>
        </div>
      </div>
    </div>
  );
}
