import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';

/** A turn error that a new Claude login fixes (expired OAuth, no login, a bad key). */
export function isClaudeAuthError(text: string): boolean {
  return /authenticat|oauth|not logged in|\/login|invalid api key|\b401\b|unauthorized/i.test(text);
}

/** How often the code box asks the daemon whether this login is still going. */
const STATUS_POLL_MS = 2000;

/**
 * The person's sentence for a failed call. The API client's message is technical
 * ("POST /api/claude-auth/login/code failed: 400 — <reason>"): show the daemon's own reason, which is
 * already a plain sentence, and a plain fallback when there is none (a lost sign-in, a reconnect).
 */
export function plainLoginError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const reason = /\bfailed: \d+ — (.+)$/s.exec(raw)?.[1]?.trim();
  if (reason && !/^no login in progress$|^login is \w+, not awaiting a code$/i.test(reason)) return reason;
  if (reason || /Reconnecting…/.test(raw)) return 'This sign-in ended. Start it again.';
  return raw;
}

const btn: React.CSSProperties = { flexShrink: 0, padding: '5px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', cursor: 'pointer', font: 'inherit', fontSize: 13 };

/**
 * Log this daemon in to Claude from Chat. It drives the daemon's headless login
 * (`/api/claude-auth`, `claude setup-token`): start → open the Claude page → paste the code.
 * The daemon keeps the token and gives it to Chat and to every Claude thread; `onDone`
 * then retries the failed turn.
 */
export function ClaudeLogin({ onDone, start: startFlow, buttonLabel = 'Log in to Claude', autoStart = false }: { onDone: () => void; start?: () => Promise<{ id?: string; url: string | null; error: string | null }>; buttonLabel?: string; /** Start at once (the caller's own button already asked to sign in). */ autoStart?: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'code' | 'sending'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const attemptId = useRef<string | undefined>(undefined);

  const start = async () => {
    setError(null);
    setPhase('starting');
    try {
      const s = await (startFlow ?? api.claudeLoginStart)();
      if (!s.url) throw new Error(s.error ?? 'Claude did not give a login link');
      attemptId.current = s.id;
      setUrl(s.url);
      setPhase('code');
    } catch (err) {
      setError(plainLoginError(err));
      setPhase('idle');
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  // The login can end with no code from this screen. Finish, or say so, so that no code goes to
  // a login that is gone.
  useEffect(() => {
    if (phase !== 'code') return;
    let stopped = false;
    const timer = setInterval(() => {
      api.claudeAuthStatus().then(({ session }) => {
        if (stopped) return;
        const mine = session && (!attemptId.current || session.id === attemptId.current);
        if (mine && session.status === 'complete') { stopped = true; setPhase('sending'); onDone(); return; }
        if (!mine || session.status === 'error') {
          stopped = true;
          // Claude's own reason when the daemon has one (a timeout, a refused code), in plain words.
          setError(mine && session.error ? session.error : 'This login ended. Start it again.');
          setUrl(null);
          setPhase('idle');
        }
      }).catch(() => { /* a network blip says nothing about the login */ });
    }, STATUS_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

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
      // The login may have finished just before this code arrived.
      const session = (await api.claudeAuthStatus().catch(() => null))?.session;
      if (session?.status === 'complete' && (!attemptId.current || session.id === attemptId.current)) { onDone(); return; }
      // The attempt is gone (a 400 with no session to resume): start again.
      setError(plainLoginError(err));
      setUrl(null);
      setPhase('idle');
    }
  };

  if (phase === 'idle' || phase === 'starting') {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" onClick={() => void start()} disabled={phase === 'starting'} style={btn}>
          {phase === 'starting' ? 'Starting login…' : buttonLabel}
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
          style={{ flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', font: 'inherit', fontSize: 16 }} />
        <button type="button" onClick={() => void submit()} disabled={phase === 'sending' || !code.trim()} style={btn}>
          {phase === 'sending' ? 'Checking…' : 'Submit code'}
        </button>
      </div>
      {error && <span style={{ fontSize: 12.5, color: 'var(--color-status-red)', wordBreak: 'break-word' }}>{error}</span>}
    </div>
  );
}
