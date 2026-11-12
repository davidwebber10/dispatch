import { useState } from 'react';
import { List, Gear } from '@phosphor-icons/react';
import { PRODUCT_NAME } from '../../../lib/hostCopy';
import { useNavigation } from '../../../stores/navigation';
import { OsAppSwitcher, useOsShell } from './OsAppSwitcher';
import { OsRailItem } from './OsLeftRail';
import { PRODUCT_ICON } from './OsIcon';
import './os-shell.css';

/**
 * The phone's way into the OS shell (explorer AppShell, mobile): a menu button and the app's name in the
 * header; the button opens a left drawer with the same app switcher as the desktop rail, and Settings.
 * The rest of the phone app (its bottom tabs, Threads | Projects) stays as it is.
 */
export function OsMobileMenu() {
  const [open, setOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const shell = useOsShell();
  const Icon = PRODUCT_ICON;
  const close = () => { setOpen(false); setSwitcherOpen(false); };
  return (
    <>
      <button type="button" className="os-icon-btn" aria-label="Open navigation" onClick={() => setOpen(true)} style={{ width: 36, height: 36 }}>
        <List size={20} />
      </button>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, font: '600 18px/28px var(--font-sans)', color: 'var(--color-text-primary)' }}>
        <Icon size={24} style={{ flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{PRODUCT_NAME}</span>
      </span>
      {open && (
        <div role="dialog" aria-label="Navigation" style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-overlay)' }}>
          <div onClick={close} style={{ position: 'absolute', inset: 0, background: 'var(--color-overlay)' }} />
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: 'min(320px, 85vw)', display: 'flex', flexDirection: 'column',
            background: 'var(--color-pane)', borderRight: '1px solid var(--color-border)', paddingTop: 'env(safe-area-inset-top)',
            boxShadow: '0 20px 50px -20px var(--color-shadow-strong)',
          }}>
            <OsAppSwitcher shell={shell} open={switcherOpen} setOpen={setSwitcherOpen} />
            <div style={{ flex: 1 }} />
            <div style={{ padding: '8px 8px calc(8px + env(safe-area-inset-bottom))' }}>
              <OsRailItem icon={Gear} label="Settings" onSelect={() => { close(); useNavigation.getState().navigate({ view: 'settings' }); }} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
