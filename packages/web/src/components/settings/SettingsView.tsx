import { useEffect, useState } from 'react';
import { SETTINGS_SECTIONS, settingsSection, useAllSettingsSections, useSettingsGroups } from './sections';
import { useUI } from '../../stores/ui';
import { UpdateBanner } from '../update/UpdateBanner';

/**
 * Desktop settings as a full page (design: "Dispatch Settings") — a view beside
 * Threads/Board/Analytics, not a modal. Left: the section nav in groups, each item with its icon.
 * Right: the section's title, then its body. The section CONTENT components are shared with
 * MobileSettings, which keeps its drill-down presentation.
 *
 * 2026-11-07 (docs/design/settings-layout.md): the content header is the title alone (no gray blurb
 * beside it, no "⌘, to reopen"), and the nav has no DAEMON block: the connection lives in
 * Settings → Servers and the version in About & updates, where each is said once.
 */
export function SettingsView() {
  const [tab, setTab] = useState<string>('appearance');
  const sections = useAllSettingsSections();
  const groups = useSettingsGroups();
  // A link elsewhere asked for a section (the mic's "Set up"): open it once.
  const pendingSection = useUI((s) => s.pendingSettingsSection);
  useEffect(() => {
    const wanted = pendingSection ? settingsSection(pendingSection) : undefined;
    if (!wanted) return;
    setTab(wanted.key);
    useUI.getState().clearSettingsRequest();
  }, [pendingSection]);

  const active = settingsSection(tab) ?? SETTINGS_SECTIONS[0];
  const Body = active.Component;

  return (
    <div data-testid="settings-view" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden', background: 'var(--color-base)' }}>
      {/* section nav */}
      <nav aria-label="Settings sections" style={{ width: 214, flexShrink: 0, background: 'var(--color-pane)', borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 14px', borderBottom: '1px solid var(--color-border)' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>Settings</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 8px' }}>
          {groups.map((g, gi) => (
            <div key={g} role="group" aria-label={g}>
              <div style={{ font: '500 9.5px var(--font-mono)', letterSpacing: '0.1em', color: 'var(--color-text-tertiary)', padding: gi === 0 ? '2px 8px 6px' : '14px 8px 6px' }}>{g}</div>
              {sections.filter((s) => s.group === g).map((s) => {
                const on = s.key === tab;
                const Icon = s.icon;
                return (
                  <button key={s.key} onClick={() => setTab(s.key)} aria-current={on ? 'page' : undefined} style={{
                    display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '6px 8px', marginBottom: 1,
                    borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer', textAlign: 'left',
                    background: on ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)' : 'transparent',
                  }}>
                    <Icon aria-hidden size={15} weight={on ? 'fill' : 'regular'} color={on ? 'var(--color-accent)' : 'var(--color-text-tertiary)'} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: on ? 500 : 400, color: on ? 'var(--color-text-primary)' : 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div style={{ borderTop: '1px solid var(--color-border)', padding: '8px 14px', font: '400 9.5px var(--font-mono)', color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
          Changes save as you edit
        </div>
      </nav>

      {/* content */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 22px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
          <h1 data-testid="settings-content-title" style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{active.label}</h1>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 22px 48px' }}>
          <div style={{ maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* An update that waits sits above every section, not only About & updates (2026-11-07). */}
            <UpdateBanner />
            {/* onDone exists for the setup wizard: leave settings so the wizard isn't buried. */}
            <Body key={active.key} onDone={() => useUI.getState().setView('workspace')} />
          </div>
        </div>
      </div>
    </div>
  );
}
