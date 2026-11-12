import { Moon, Sun, User } from '@phosphor-icons/react';
import { useActiveTheme } from '../../../themes/apply';
import { useSettings } from '../../../stores/settings';
import { useNavigation } from '../../../stores/navigation';
import { useOsShell } from './OsAppSwitcher';
import './os-shell.css';

function initials(name: string): string {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/**
 * The right end of the tab bar, as OS DesktopShell: a hairline, then the light/dark switch and the
 * person's avatar (initials; it opens Settings > Accounts). Hosted / business preview only.
 */
export function OsTopBarActions() {
  const kind = useActiveTheme((s) => s.theme.kind);
  const shell = useOsShell();
  const name = shell?.user?.name ?? '';
  const flip = () => useSettings.getState().setTheme(kind === 'dark' ? 'os-light' : 'os-dark');
  return (
    <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 4, padding: '0 12px', borderLeft: '1px solid var(--color-border)', background: 'var(--color-base)' }}>
      <button type="button" className="os-icon-btn" onClick={flip} title={kind === 'dark' ? 'Light theme' : 'Dark theme'} aria-label={kind === 'dark' ? 'Light theme' : 'Dark theme'} style={{ width: 32, height: 32 }}>
        {kind === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <button type="button" className="os-icon-btn" title={shell?.user?.email ?? 'Account'} aria-label="Account"
        onClick={() => useNavigation.getState().navigate({ view: 'settings', section: 'accounts' })}
        style={{ width: 32, height: 32, borderRadius: '50%', background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)', color: 'var(--color-text-primary)', font: '600 12px var(--font-sans)' }}>
        {name ? initials(name) : <UserGlyph />}
      </button>
    </div>
  );
}

function UserGlyph() { return <User size={16} />; }
