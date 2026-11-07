import { useEffect, useRef, useState } from 'react';
import { ArrowSquareOut, ArrowClockwise, Copy, Check } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { CodexLoginSession } from '../../api/types';
import { copyText } from '../../lib/clipboard';
import { solidBtn, ghostBtn } from './ui';

/** How often the daemon is asked whether the code was approved. A test sets it lower. */
export const codexLoginTiming = { pollMs: 2000 };

const errorText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^.*? failed: \d+ — /, '') : String(err));

/**
 * Sign a Codex account in with the device code (2026-11-07). The daemon runs
 * `codex login --device-auth` in the account's folder; this shows its link and one-time code and
 * asks the daemon until the login is done. It works from a phone or another computer: nothing
 * comes back to `localhost`, so there is nothing to copy back here.
 */
export function CodexLogin({ accountId, onDone, onCancel }: { accountId: string; onDone: () => void; onCancel?: () => void }) {
  const [session, setSession] = useState<CodexLoginSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!alive) return;
      try {
        const s = await api.accountsCodexLoginStatus(accountId);
        if (!alive) return;
        if (s.status === 'complete') { doneRef.current(); return; }
        if (s.status === 'error' || s.status === 'idle') { setSession(null); setError(s.error ?? 'The sign-in stopped before it finished.'); return; }
        setSession(s);
      } catch { /* a dropped request: ask again on the next tick */ }
      timer = setTimeout(() => void poll(), codexLoginTiming.pollMs);
    };
    (async () => {
      setError(null); setSession(null);
      try {
        const s = await api.accountsCodexLogin(accountId);
        if (!alive) return;
        if (s.status === 'complete') { doneRef.current(); return; }
        if (s.status === 'error' || !s.code) { setError(s.error ?? 'Codex did not show a sign-in code.'); return; }
        setSession(s);
        timer = setTimeout(() => void poll(), codexLoginTiming.pollMs);
      } catch (err) {
        if (alive) setError(errorText(err));
      }
    })();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [accountId, attempt]);

  const cancel = async () => {
    try { await api.accountsCodexLoginCancel(accountId); } catch { /* the attempt ends on its own when the code expires */ }
    onCancel?.();
  };
  const copy = async () => {
    if (!session?.code) return;
    try { await copyText(session.code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the code stays on screen to type */ }
  };

  const iconBtn: React.CSSProperties = { ...ghostBtn, display: 'inline-flex', alignItems: 'center', gap: 6 };
  return (
    <div data-testid="codex-login" style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      {error ? (
        <>
          <span role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>{error}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} style={{ ...solidBtn(true), display: 'inline-flex', alignItems: 'center', gap: 6 }}><ArrowClockwise size={13} weight="bold" />Try again</button>
            {onCancel && <button type="button" onClick={() => void cancel()} style={ghostBtn}>Cancel</button>}
          </div>
        </>
      ) : !session ? (
        <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>Asking Codex for a sign-in code…</span>
      ) : (
        <>
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
            1. Open the page on any device and sign in to ChatGPT. 2. Enter this code. This updates by itself when you are done.
          </span>
          <a href={session.url ?? undefined} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-accent)', fontWeight: 600, fontSize: 13.5, overflowWrap: 'anywhere' }}>
            Open the Codex sign-in page<ArrowSquareOut size={14} />
          </a>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ font: '600 20px var(--font-mono)', letterSpacing: 2, color: 'var(--color-text-primary)', padding: '4px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)' }}>{session.code}</span>
            <button type="button" aria-label="Copy the code" onClick={() => void copy()} style={iconBtn}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
            The code expires in 15 minutes. If ChatGPT refuses it, turn on device code sign-in for Codex in ChatGPT's security settings.
          </span>
          {onCancel && <div><button type="button" onClick={() => void cancel()} style={ghostBtn}>Cancel</button></div>}
        </>
      )}
    </div>
  );
}
