import { CaretRight } from '@phosphor-icons/react';
import { SETTINGS_SECTIONS, settingsSection, type SettingsSectionKey } from './sections';

/**
 * Mobile settings, presented as an iOS-style drill-down rather than the desktop
 * modal: `MobileSettingsList` is the level-0 rail screen (the Settings bottom tab)
 * and `MobileSettingsSection` is the level-1 screen it pushes to.
 *
 * Both render the SAME section components as SettingsModal — only the chrome
 * differs. See `sections.tsx`.
 */
export function MobileSettingsList({ onOpen }: { onOpen: (key: SettingsSectionKey) => void }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '4px 0 12px' }}>
      {SETTINGS_SECTIONS.map((s) => {
        const Icon = s.icon;
        return (
          <button key={s.key} onClick={() => onOpen(s.key)}
            style={{ display: 'flex', alignItems: 'center', gap: 13, width: '100%', textAlign: 'left', padding: '14px 14px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }}>
            <span style={{ width: 30, height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9, background: 'var(--color-elevated)', border: '1px solid #2C2C32', color: 'var(--color-text-secondary)' }}>
              <Icon size={17} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>{s.label}</span>
              <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.blurb}</span>
            </span>
            <CaretRight size={18} color="var(--color-text-tertiary)" />
          </button>
        );
      })}
    </div>
  );
}

export function MobileSettingsSection({ sectionKey }: { sectionKey: SettingsSectionKey }) {
  const section = settingsSection(sectionKey);
  if (!section) return null;
  const Body = section.Component;
  // No `onDone`: settings is a screen here, not an overlay, so opening the setup
  // wizard has no chrome to dismiss.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 14px 24px' }}>
      <Body />
    </div>
  );
}
