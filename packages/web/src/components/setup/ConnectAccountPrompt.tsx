import { useState } from 'react';
import { SignIn, X } from '@phosphor-icons/react';
import { useNavigation } from '../../stores/navigation';

/**
 * The one sign-in entry point of a business person (no setup wizard, lib/profile.ts): a small card
 * "Connect your Claude account" that opens the account sign-in UI (Settings > Accounts). It can be
 * closed for this page; it comes back on the next launch while Claude is still not connected.
 */
export function ConnectAccountPrompt() {
  const [closed, setClosed] = useState(false);
  if (closed) return null;
  const connect = () => { setClosed(true); useNavigation.getState().navigate({ view: 'settings', section: 'accounts' }); };
  return (
    <div role="region" aria-label="Connect your Claude account" style={{
      position: 'fixed', left: '50%', bottom: 'calc(84px + env(safe-area-inset-bottom))', transform: 'translateX(-50%)', zIndex: 'var(--z-overlay)',
      width: 'min(440px, calc(100vw - 24px))', display: 'flex', alignItems: 'center', gap: 12, padding: '12px 12px 12px 16px',
      background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-lg)',
      boxShadow: '0 20px 50px -20px var(--color-shadow-strong)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>Connect your Claude account</div>
        <div style={{ marginTop: 2, fontSize: 12, color: 'var(--color-text-secondary)' }}>Your chats run on your own Claude account.</div>
      </div>
      <button type="button" onClick={connect} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', border: 'none', borderRadius: 'var(--radius-md)',
        background: 'var(--color-accent)', color: 'var(--color-on-accent)', font: '600 12.5px var(--font-sans)', cursor: 'pointer',
      }}>
        <SignIn size={14} weight="bold" /> Connect
      </button>
      <button type="button" aria-label="Close" onClick={() => setClosed(true)} style={{ display: 'flex', padding: 4, background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>
        <X size={14} />
      </button>
    </div>
  );
}
