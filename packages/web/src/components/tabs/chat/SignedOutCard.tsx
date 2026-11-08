import { useEffect, useState } from 'react';
import { ArrowClockwise, SignIn, UserSwitch, WarningCircle } from '@phosphor-icons/react';
import type { Terminal, ProviderName } from '../../../api/types';
import { api } from '../../../api/client';
import { useAccounts, accountProviderOf, threadAccount } from '../../../stores/accounts';
import { useUI } from '../../../stores/ui';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { ClaudeLogin } from '../../endless/ClaudeLogin';
import { CodexLogin } from '../../settings/CodexLogin';
import { AccountSwitchModal } from '../../common/AccountSwitchModal';
import { startCliSignIn } from '../../../lib/cliSignIn';
import { HARNESSES } from '../../../lib/harnesses';
import type { AuthRequired } from './useStructuredChat';

type Phase = 'idle' | 'signing-in' | 'cli-thread' | 'signed-in';

/**
 * The Pretty card for a signed-out or expired login (system/auth_required), shown in place of the
 * raw error. "<Account> is signed out", then one primary action, Sign in, and a secondary one,
 * Switch account. Sign in opens the EXISTING flow for that login, never a new one:
 *   Claude, an added account → the headless `claude setup-token` flow for it (POST /api/accounts/claude/login,
 *                              which now replaces that account's token instead of adding a twin)
 *   Claude, the CLI login    → the daemon's own headless login (POST /api/claude-auth/login)
 *   Codex, an added account  → the device code (CodexLogin, POST /api/accounts/codex/:id/login)
 *   Codex CLI login, Grok, OpenCode → the CLI's own sign-in thread ("Sign in — <Harness>", lib/cliSignIn)
 * Switch account opens the existing AccountSwitchModal (Claude Code and Codex only).
 *
 * Retry is a button, not automatic: the failed message may have half-run, an added account's new
 * token is saved a moment after the flow reports done, and a CLI sign-in finishes in another thread
 * Dispatch cannot see end. The card goes away when a turn succeeds (useStructuredChat).
 */
export function SignedOutCard({ tab, auth, onRetry }: { tab: Terminal; auth: AuthRequired; onRetry: () => void }) {
  const isMobile = useIsMobile();
  const view = useAccounts((s) => s.view);
  useEffect(() => { if (!view) void useAccounts.getState().load(); }, [view]);
  const provider = accountProviderOf(tab.type);
  const accounts = provider && view ? view[provider] : [];
  const signedOut = auth.accountId ? accounts.find((a) => a.id === auth.accountId) : undefined;
  const current = threadAccount(view, tab);
  const harness = HARNESSES.find((h) => h.type === tab.type);
  const harnessLabel = harness?.label ?? tab.type;
  const who = provider ? signedOut?.label ?? current?.label ?? harnessLabel : harnessLabel;
  // The thread was moved to another account since the failure (Switch account).
  const moved = !!(provider && auth.accountId && current && current.id !== auth.accountId);
  const [phase, setPhase] = useState<Phase>('idle');
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCliLogin = !signedOut || signedOut.isCli;
  const flow: 'claude-cli' | 'claude-account' | 'codex-account' | 'cli-thread' =
    tab.type === 'claude-code' ? (isCliLogin ? 'claude-cli' : 'claude-account')
      : tab.type === 'codex' && !isCliLogin ? 'codex-account'
        : 'cli-thread';

  const signIn = async () => {
    setError(null);
    if (flow !== 'cli-thread') { setPhase('signing-in'); return; }
    try {
      const id = await startCliSignIn(tab.sessionId, (harness?.provider ?? 'claude') as ProviderName, harnessLabel);
      useUI.getState().requestOpenTab(id);
      setPhase('cli-thread');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the sign-in.');
    }
  };

  const solid: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: isMobile ? 40 : 32, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-md)', color: 'var(--color-on-accent)', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
  const ghost: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: isMobile ? 40 : 32, padding: '0 14px', background: 'transparent', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', font: 'inherit', fontSize: 13, cursor: 'pointer' };
  const retryBtn = <button type="button" onClick={onRetry} style={solid}><ArrowClockwise size={14} weight="bold" />Retry</button>;

  let body: React.ReactNode;
  if (moved) {
    body = (
      <>
        <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>This thread now runs on {current!.label}. Retry sends your last message again.</span>
        <div>{retryBtn}</div>
      </>
    );
  } else if (phase === 'signed-in') {
    body = (
      <>
        <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>Signed in. Retry sends your last message again.</span>
        <div>{retryBtn}</div>
      </>
    );
  } else if (phase === 'cli-thread') {
    body = (
      <>
        <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          Finish the sign-in in the “Sign in — {harnessLabel}” thread, then come back and retry.
        </span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{retryBtn}<button type="button" onClick={() => setPhase('idle')} style={ghost}>Back</button></div>
      </>
    );
  } else if (phase === 'signing-in') {
    const done = () => { void useAccounts.getState().load(); setPhase('signed-in'); };
    body = flow === 'codex-account'
      ? <CodexLogin accountId={signedOut!.id} onDone={done} onCancel={() => setPhase('idle')} />
      : flow === 'claude-account'
        ? <ClaudeLogin autoStart start={() => api.accountsClaudeLogin(signedOut!.label)} onDone={done} buttonLabel="Sign in" />
        : <ClaudeLogin autoStart onDone={done} buttonLabel="Sign in" />;
  } else {
    body = (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => void signIn()} style={solid}><SignIn size={14} weight="bold" />Sign in</button>
        {provider && <button type="button" onClick={() => setSwitching(true)} style={ghost}><UserSwitch size={14} weight="bold" />Switch account</button>}
      </div>
    );
  }

  return (
    <div role="group" aria-label="Signed out" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: isMobile ? 14 : 12, border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-lg)', background: 'var(--color-elevated)', maxWidth: 520 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <WarningCircle size={18} weight="fill" color="var(--color-status-yellow)" style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: isMobile ? 15 : 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>{`${who} is signed out`}</span>
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>{auth.reason}</span>
        </div>
      </div>
      {body}
      {error && <span role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</span>}
      {auth.detail && (
        <details style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
          <summary style={{ cursor: 'pointer' }}>What the CLI said</summary>
          <span style={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>{auth.detail}</span>
        </details>
      )}
      {switching && <AccountSwitchModal tab={tab} onClose={() => setSwitching(false)} />}
    </div>
  );
}
