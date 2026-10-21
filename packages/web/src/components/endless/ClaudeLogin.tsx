import { useState } from 'react';
import { api } from '../../api/client';

/** A turn error that a new Claude login fixes (expired OAuth, no login, a bad key). */
export function isClaudeAuthError(text: string): boolean {
  return /authenticat|oauth|not logged in|\/login|invalid api key|\b401\b|unauthorized/i.test(text);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const btn: React.CSSProperties = { flexShrink: 0, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', cursor: 'pointer', font: 'inherit', fontSize: 13 };

/**
 * Log this daemon in to Claude from Chat. It drives the daemon's headless login
 * (`/api/claude-auth`, `claude setup-token`): start → open the Claude page → paste the code.
 * The daemon keeps the token and gives it to Chat and to every Claude thread; `onDone`
 * then retries the failed turn.
 */
export function ClaudeLogin({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'code' | 'sending'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    setPhase('starting');
    try {
      const s = await api.claudeLoginStart();
      if (!s.url) throw new Error(s.error ?? 'Claude did not give a login link');
      setUrl(s.url);
      setPhase('code');
    } catch (err) {
      setError(errorText(err));
      setPhase('idle');
    }
  };

  const submit = async () => {
    const c = code.trim();
    if (!c) return;
    setError(null);
    setPhase('sending');
    try {
      const s = await api.claudeLoginCode(c);
      if (s.status === 'complete') { onDone(); return; }
      setError(s.error ?? 'The login did not finish. Try the code again.');
      setPhase('code');
    } catch (err) {
      // The attempt is gone (a 400 with no session to resume): start again.
      setError(errorText(err));
      setUrl(null);
      setPhase('idle');
    }
  };

  if (phase === 'idle' || phase === 'starting') {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" onClick={() => void start()} disabled={phase === 'starting'} style={btn}>
          {phase === 'starting' ? 'Starting login…' : 'Log in to Claude'}
        </button>
        {error && <span style={{ fontSize: 12.5, color: 'var(--color-status-red)', wordBreak: 'break-word' }}>{error}</span>}
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      <a href={url ?? undefined} target="_blank" rel="noreferrer" style={{ color: 'var(--color-accent)', fontWeight: 600, fontSize: 13.5 }}>
        Open the Claude login page ↗
      </a>
      <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>Sign in, approve, then paste the code that Claude shows.</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <input aria-label="Login code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
          style={{ flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', font: 'inherit', fontSize: 16 }} />
        <button type="button" onClick={() => void submit()} disabled={phase === 'sending' || !code.trim()} style={btn}>
          {phase === 'sending' ? 'Checking…' : 'Submit code'}
        </button>
      </div>
      {error && <span style={{ fontSize: 12.5, color: 'var(--color-status-red)', wordBreak: 'break-word' }}>{error}</span>}
    </div>
  );
}
