import { useState } from 'react';
import { Compass, ArrowLeft, ArrowSquareOut } from '@phosphor-icons/react';
import { hostContext, isBusinessPreview } from '../../lib/hostContext';
import { PLATFORM_NAME, PRODUCT_NAME } from '../../lib/hostCopy';

/**
 * The way back to Polywood OS (hosted workspace, or the business preview). Top-left of the rail on a
 * computer and of the header on a phone, in place of the server switcher: a neutral app glyph, the
 * product name, and a menu with "Back to POLYWOOD OS" (same tab) and "Open OS in a new tab".
 * No machine words: no version, no server list.
 */
export function HostedBrand({ variant = 'rail' }: { variant?: 'rail' | 'header' }) {
  const [open, setOpen] = useState(false);
  const os = hostContext().osBaseUrl;
  const preview = isBusinessPreview();
  const rail = variant === 'rail';

  const item: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 9px', minHeight: 36,
    background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-primary)',
    cursor: 'pointer', textAlign: 'left', textDecoration: 'none', fontSize: 13,
  };

  return (
    <div style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        aria-label={`${PRODUCT_NAME} menu`} title={PRODUCT_NAME}
        style={{
          display: 'flex', flexDirection: rail ? 'column' : 'row', alignItems: 'center', gap: rail ? 3 : 7,
          padding: rail ? 2 : '0 2px', background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'var(--color-text-primary)',
        }}>
        <span style={{
          width: 30, height: 30, borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          outline: open ? '2px solid color-mix(in srgb, var(--color-accent) 40%, transparent)' : 'none', outlineOffset: 2,
        }}>
          <Compass size={17} weight="bold" color="var(--color-on-accent)" />
        </span>
        <span style={rail
          ? { fontSize: 10, fontWeight: 600, letterSpacing: '-0.1px', color: 'var(--color-text-secondary)' }
          : { fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)' }}>{PRODUCT_NAME}</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-dropdown)' }} />
          <div role="menu" aria-label={`${PRODUCT_NAME} menu`} style={{
            position: 'absolute', top: rail ? 0 : 38, left: rail ? 52 : 0, zIndex: 'var(--z-dropdown)', minWidth: 236,
            background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-lg)',
            padding: 4, boxShadow: '0 20px 50px -20px var(--color-shadow-strong)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px 6px' }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--color-text-primary)' }}>{PRODUCT_NAME}</span>
              {preview && (
                <span style={{ font: '500 10.5px var(--font-sans)', padding: '1px 7px', borderRadius: 'var(--radius-pill)', background: 'color-mix(in srgb, var(--color-accent) 16%, transparent)', color: 'var(--color-text-primary)' }}>
                  Business preview
                </span>
              )}
            </div>
            {os ? (
              <>
                <a role="menuitem" href={os} style={item} onClick={() => setOpen(false)}>
                  <ArrowLeft size={15} /> Back to {PLATFORM_NAME}
                </a>
                <a role="menuitem" href={os} target="_blank" rel="noopener noreferrer" style={item} onClick={() => setOpen(false)}>
                  <ArrowSquareOut size={15} /> Open OS in a new tab
                </a>
              </>
            ) : (
              <div style={{ padding: '6px 9px 8px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                {preview ? `On a ${PLATFORM_NAME} workspace, this menu leads back to ${PLATFORM_NAME}.` : `${PLATFORM_NAME} is not available right now.`}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
