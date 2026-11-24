import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { fontVar, fontVarInput } from '../../lib/fontSize';

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

const btn: React.CSSProperties = { flexShrink: 0, padding: '5px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', cursor: 'pointer', font: 'inherit', fontSize: fontVar(13) };

/**
 * Log this daemon in to Claude from Chat. It drives the daemon's headless login
 * (`/api/claude-auth`, `claude setup-token`): start → open the Claude page → paste the code.
 * The daemon keeps the token and gives it to Chat and to every Claude thread; `onDone`
 * then retries the failed turn.
 */
export function ClaudeLogin({ onDone, start: startFlow, buttonLabel = 'Log in to Claude', autoStart = false }: { onDone: () => void; start?: () => Promise<{ id?: string; url: string | null; error: string | null }>; buttonLabel?: string; /** Start at once (the caller's own button already asked to sign in). */ autoStart?: boolean }) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'code' | 'sending' | 'ask'>('idle');
  // The generic card only (no `start` of its own): where the sign-in lands, and the account it made.
  const [landsIn, setLandsIn] = useState<{ kind: 'new' | 'existing'; label: string } | null>(null);
  const [made, setMade] = useState<{ id: string; label: string } | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  /**
   * The sign-in is complete. A generic sign-in that made an account which is not the default asks
   * before the default changes (one source for the Claude login, spec 2026-11-23): an update or a
   * sign-in never moves new threads to another login by itself.
   */
  const finish = (session: { account?: { id: string; label: string; isDefault: boolean } } | null | undefined) => {
    if (!startFlow && session?.account && !session.account.isDefault) { setMade(session.account); setPhase('ask'); return; }
    onDone();
  };
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const attemptId = useRef<string | undefined>(undefined);
  const urlRef = useRef<string | null>(null); // the link on screen, for the poll below

  const start = async () => {
    setError(null);
    setPhase('starting');
    try {
      const s = await (startFlow ?? api.claudeLoginStart)();
      if (!s.url) throw new Error(s.error ?? 'Claude did not give a login link');
      attemptId.current = s.id;
      setLandsIn(startFlow ? null : (s as { landsIn?: { kind: 'new' | 'existing'; label: string } }).landsIn ?? null);
      setUrl(s.url); urlRef.current = s.url;
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
        if (mine && session.status === 'complete') { stopped = true; setPhase('sending'); finish(session); return; }
        // After a refused code the CLI's new link can come late: show the one the daemon holds now.
        if (mine && session.status === 'awaiting_code' && session.url && session.url !== urlRef.current) { urlRef.current = session.url; setUrl(session.url); setCode(''); }
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
      const s = await api.claudeLoginCode(c, attemptId.current);
      if (s.status === 'complete') { finish(s); return; }
      setError(s.error ?? 'The login did not finish. Try the code again.');
      // A refused code makes the CLI start a new sign-in: the link is new, the old code is dead.
      if (s.url && s.url !== urlRef.current) { setUrl(s.url); urlRef.current = s.url; setCode(''); }
      setPhase('code');
    } catch (err) {
      // The login may have finished just before this code arrived.
      const session = (await api.claudeAuthStatus().catch(() => null))?.session;
      if (session?.status === 'complete' && (!attemptId.current || session.id === attemptId.current)) { finish(session); return; }
      // The attempt is gone (a 400 with no session to resume): start again.
      setError(plainLoginError(err));
      setUrl(null);
      setPhase('idle');
    }
  };

  if (phase === 'ask' && made) {
    const makeDefault = async () => {
      setAskError(null);
      try { await api.accountsSetDefault('claude', made.id); onDone(); }
      catch { setAskError('Could not change the default. You can set it in Settings, Accounts.'); }
    };
    return (
      <div data-testid="claude-login-ask-default" style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
        <span style={{ fontSize: fontVar(13), color: 'var(--color-text-primary)' }}>Signed in. The login is saved as “{made.label}”.</span>
        <span style={{ fontSize: fontVar(12.5), color: 'var(--color-text-secondary)' }}>
          Use this login for new threads and Chat? It has no claude.ai connectors (mail, calendar, chat). Your default account stays as it is unless you choose this.
        </span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => void makeDefault()} style={btn}>Make default</button>
          <button type="button" onClick={() => onDone()} style={btn}>Not now</button>
        </div>
        {askError && <span style={{ fontSize: fontVar(12.5), color: 'var(--color-status-red)' }}>{askError}</span>}
      </div>
    );
  }

  if (phase === 'idle' || phase === 'starting') {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" onClick={() => void start()} disabled={phase === 'starting'} style={btn}>
          {phase === 'starting' ? 'Starting login…' : buttonLabel}
        </button>
        {error && <span style={{ fontSize: fontVar(12.5), color: 'var(--color-status-red)', wordBreak: 'break-word' }}>{error}</span>}
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      {landsIn?.kind === 'new' && (
        <div data-testid="claude-login-two-ways" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: fontVar(12.5), color: 'var(--color-text-secondary)' }}>
          <span>Your computer’s Claude login is signed out. Run <code>claude</code> in a terminal and sign in there to keep your claude.ai connectors (mail, calendar, chat).</span>
          <span>Or sign in here. This makes a Dispatch login, which has no claude.ai connectors.</span>
        </div>
      )}
      <a href={url ?? undefined} target="_blank" rel="noreferrer" style={{ color: 'var(--color-accent)', fontWeight: 600, fontSize: fontVar(13.5) }}>
        Open the Claude login page ↗
      </a>
      <span style={{ fontSize: fontVar(12.5), color: 'var(--color-text-secondary)' }}>Sign in, approve, then paste the code that Claude shows.</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <input aria-label="Login code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
          style={{ flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', font: 'inherit', fontSize: fontVarInput(16) }} />
        <button type="button" onClick={() => void submit()} disabled={phase === 'sending' || !code.trim()} style={btn}>
          {phase === 'sending' ? 'Checking…' : 'Submit code'}
        </button>
      </div>
      {error && <span style={{ fontSize: fontVar(12.5), color: 'var(--color-status-red)', wordBreak: 'break-word' }}>{error}</span>}
    </div>
  );
}
