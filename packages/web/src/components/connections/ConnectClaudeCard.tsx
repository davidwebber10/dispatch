import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ClaudeLogin } from '../endless/ClaudeLogin';
import { claudeCardShown, claudeConnected, useClaudeConnect } from './claudeConnect';

/**
 * "Connect your Claude account": the one guided step a person on a hosted box takes before the first
 * chat (open the Claude page, paste the code). Shown only when the daemon runs the clean login
 * (`method: 'claude-auth-login'`, core auth/claude-cli-login.ts) and `claude auth status` says signed
 * out. It is also the "Reconnect Claude" entry: a thread's sign-in card leads to the same flow. A
 * local install never shows it.
 */
export function ConnectClaudeCard({ onConnected }: { onConnected?: () => void }) {
  const [state, setState] = useState<'unknown' | 'needed' | 'ok'>('unknown');
  const check = () => api.claudeAuthStatus()
    .then((s) => setState(s.method === 'claude-auth-login' && !s.authenticated ? 'needed' : 'ok'))
    .catch(() => setState('ok'));
  useEffect(() => { void check(); }, []);
  const connected = useClaudeConnect((s) => s.connected);
  // While this card is on screen, the workspace prompt (setup/ConnectAccountPrompt) stays hidden.
  useEffect(() => (state === 'needed' && !connected ? claudeCardShown() : undefined), [state, connected]);
  if (state !== 'needed' || connected) return null;
  return (
    <div data-testid="connect-claude" style={{ flexShrink: 0, maxWidth: 768, width: 'calc(100% - 28px)', boxSizing: 'border-box', margin: '10px auto 0', padding: '14px 16px', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-text-primary)' }}>Connect your Claude account</div>
      <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
        Your threads run on your own Claude subscription. Open the Claude page, sign in, then paste the code it shows.
      </div>
      <ClaudeLogin buttonLabel="Connect Claude" onDone={() => { setState('ok'); claudeConnected(); onConnected?.(); }} />
    </div>
  );
}
