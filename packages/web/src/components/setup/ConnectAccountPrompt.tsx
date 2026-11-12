import { useState } from 'react';
import { SignIn, X } from '@phosphor-icons/react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ClaudeLogin } from '../endless/ClaudeLogin';
import { claudeConnected, useClaudeConnect } from '../connections/claudeConnect';

/**
 * The one sign-in step of a business person (no setup wizard, no terminal, lib/profile.ts): a small card
 * "Connect your Claude account". Connect runs the login right here (endless/ClaudeLogin: the daemon
 * starts `claude auth login`, the person opens Anthropic's page, signs in and pastes the code). It gives
 * way to the same card above an open chat thread, so the step is never offered twice. It can be closed
 * for this page; it comes back on the next launch while Claude is still not connected.
 */
export function ConnectAccountPrompt() {
  const [closed, setClosed] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const phone = useIsMobile();
  const inThread = useClaudeConnect((s) => s.cards > 0);
  const connected = useClaudeConnect((s) => s.connected);
  if (closed || connected || inThread) return null;
  return (
    <div role="region" aria-label="Connect your Claude account" data-testid="connect-claude-prompt" style={{
      position: 'fixed', left: '50%', transform: 'translateX(-50%)',
      // Desktop: under the tab bar. Phone: above the bottom tabs, where it covers no list header.
      ...(phone ? { bottom: 'calc(84px + env(safe-area-inset-bottom))' } : { top: 'calc(64px + env(safe-area-inset-top))' }), zIndex: 'var(--z-overlay)',
      width: 'min(460px, calc(100vw - 24px))', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 12px 12px 16px',
      background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-lg)',
      boxShadow: '0 20px 50px -20px var(--color-shadow-strong)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>Connect your Claude account</div>
          <div style={{ marginTop: 2, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {signingIn ? 'Open the Claude page, sign in, then paste the code it shows.' : 'Your chats run on your own Claude account.'}
          </div>
        </div>
        {!signingIn && (
          <button type="button" onClick={() => setSigningIn(true)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', border: 'none', borderRadius: 'var(--radius-md)',
            background: 'var(--color-accent)', color: 'var(--color-on-accent)', font: '600 12.5px var(--font-sans)', cursor: 'pointer',
          }}>
            <SignIn size={14} weight="bold" /> Connect
          </button>
        )}
        <button type="button" aria-label="Close" onClick={() => setClosed(true)} style={{ display: 'flex', padding: 4, background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>
          <X size={14} />
        </button>
      </div>
      {signingIn && <ClaudeLogin autoStart buttonLabel="Connect Claude" onDone={() => { claudeConnected(); setClosed(true); }} />}
    </div>
  );
}
