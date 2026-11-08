import { CaretRight } from '@phosphor-icons/react';
import { settingsSection, useAllSettingsSections, useSettingsGroups } from './sections';
import { UpdateBanner } from '../update/UpdateBanner';

/**
 * Mobile settings, presented as an iOS-style drill-down rather than the desktop page:
 * `MobileSettingsList` is the level-0 rail screen (the Settings bottom tab), grouped
 * cards under YOU / AGENTS / THIS MAC, and `MobileSettingsSection` is the level-1
 * screen it pushes to.
 *
 * Both render the SAME section components as the desktop SettingsView; only the
 * chrome differs. See `sections.tsx`.
 */
export function MobileSettingsList({ onOpen }: { onOpen: (key: string) => void }) {
  const sections = useAllSettingsSections();
  const groups = useSettingsGroups();
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '4px 14px 16px' }}>
      {/* An update that waits heads the list (2026-11-07); the Settings tab's dot points here. */}
      <div style={{ marginTop: 8 }}><UpdateBanner compact /></div>
      {groups.map((g) => {
        const rows = sections.filter((s) => s.group === g);
        return (
          <section key={g} aria-label={g} style={{ marginTop: 10 }}>
            <div style={{ font: '500 10.5px var(--font-mono)', letterSpacing: '0.12em', color: 'var(--color-text-tertiary)', padding: '8px 4px 6px' }}>{g}</div>
            <div style={{ background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
              {rows.map((s, i) => {
                const Icon = s.icon;
                return (
                  <button key={s.key} onClick={() => onOpen(s.key)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '10px 12px', background: 'transparent', border: 'none', borderTop: i > 0 ? '1px solid var(--color-border)' : 'none', cursor: 'pointer' }}>
                    <span style={{ width: 30, height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', color: 'var(--color-text-secondary)' }}>
                      <Icon size={17} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 15, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
                      {s.blurb && <span style={{ display: 'block', marginTop: 1, fontSize: 12.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.blurb}</span>}
                    </span>
                    <CaretRight aria-hidden size={16} color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function MobileSettingsSection({ sectionKey }: { sectionKey: string }) {
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
