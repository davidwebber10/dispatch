import { useState } from 'react';
import { SETTINGS_SECTIONS, settingsSection, type SettingsSectionKey } from './sections';

/**
 * Desktop settings chrome: a centred modal with a horizontal tab strip.
 *
 * The section content itself lives in `sections.tsx` and is shared with the mobile
 * settings screens (MobileSettings), which present the same sections as a
 * drill-down list instead. This component is only the desktop presentation.
 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsSectionKey>('general');
  if (!open) return null;

  const active = settingsSection(tab) ?? SETTINGS_SECTIONS[0];
  const Body = active.Component;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '100%', maxHeight: '90vh', overflow: 'hidden', background: '#18181b', border: '1px solid #2f2f35', borderRadius: 14, boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px 0' }}>
          <span style={{ fontSize: 17, fontWeight: 600 }}>Settings</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>×</button>
        </div>

        {/* Tabs — horizontally scrollable so the row never wraps or squishes on a
            narrow window; iOS momentum + hidden scrollbar. */}
        <div style={{ flexShrink: 0, display: 'flex', gap: 4, padding: '12px 20px 0', borderBottom: '1px solid var(--color-hover)', overflowX: 'auto', overflowY: 'hidden', flexWrap: 'nowrap', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
          {SETTINGS_SECTIONS.map((s) => (
            <button key={s.key} onClick={() => setTab(s.key)} style={{
              position: 'relative', flexShrink: 0, whiteSpace: 'nowrap', padding: '8px 14px 11px', background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: tab === s.key ? 600 : 500,
              color: tab === s.key ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              borderBottom: `2px solid ${tab === s.key ? 'var(--color-accent)' : 'transparent'}`, marginBottom: -1,
            }}>{s.label}</button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Body onDone={onClose} />
        </div>

        <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'flex-end', padding: '14px 20px', borderTop: '1px solid var(--color-hover)' }}>
          <button onClick={onClose} style={{ height: 34, padding: '0 20px', background: 'var(--color-accent)', border: 'none', borderRadius: 9, color: '#08240F', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Done</button>
        </div>
      </div>
    </div>
  );
}
