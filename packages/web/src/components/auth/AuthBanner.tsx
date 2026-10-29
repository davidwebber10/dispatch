import { useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../stores/auth';
import { useTabs, findTerminal } from '../../stores/tabs';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { AuthRequest } from '../../api/types';

/**
 * Mirrors AUTH_SIGNALS in core's auth/url-detect.ts (web cannot import core). The
 * terminal-output scanner only ever relays sign-in URLs, but the open/$BROWSER shims relay
 * ANY http(s) URL an agent opens — a docs page, an artifact preview — so those need the URL
 * itself to say whether this is a sign-in or just a link.
 */
const AUTH_SIGNALS = [
  'oauth', 'authorize', 'auth/', 'auth.', '/auth', 'login', 'signin', 'sign-in', 'sign_in',
  'device', 'verify', 'activate', 'user_code', 'usercode', 'sso', 'connect/token',
];

function isSignIn(req: AuthRequest): boolean {
  if (req.source === 'terminal-output') return true;
  const hay = req.url.toLowerCase();
  return AUTH_SIGNALS.some((s) => hay.includes(s));
}

const primary: React.CSSProperties = { height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const ghost: React.CSSProperties = { height: 28, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' };

export function AuthBanner() {
  // Select the STABLE array and derive here. A selector that returns `.filter(...)` hands
  // zustand a new array every render, so its snapshot never settles and React loops until
  // it throws "Maximum update depth exceeded".
  const requests = useAuth((s) => s.requests);
  const pending = requests.filter((r) => r.status === 'pending' || r.status === 'opened');
  const req = pending[0];
  // Resolve which agent/mission needs auth (falls back to generic copy if the
  // terminal's project tabs haven't been loaded, or this request predates terminalId).
  const agentLabel = useTabs((s) => (req?.terminalId ? findTerminal(s.byProject, req.terminalId)?.label : undefined));
  const [cb, setCb] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Which request the user minimized. Keyed by id so a NEW sign-in re-opens the banner: a
  // pending login the user has never seen must not stay hidden behind an old minimize.
  const [minimizedFor, setMinimizedFor] = useState<string | null>(null);
  // Tagged with the request it failed for, so a later request never shows a stale error.
  const [dismissFail, setDismissFail] = useState<{ id: string; msg: string } | null>(null);
  const isMobile = useIsMobile();
  if (!req) return null;
  const minimized = minimizedFor === req.id;
  const dismissErr = dismissFail?.id === req.id ? dismissFail.msg : null;

  // Dismiss used to be `void api.dismissAllAuth()`: a failed call changed nothing on screen,
  // so the banner just looked stuck. Show the server's { error } text and let the user retry.
  // Failing from the pill expands the banner, since the message lives in the card.
  const dismissAll = async () => {
    const id = req.id;
    setDismissFail(null);
    try {
      await api.dismissAllAuth();
    } catch (e: any) {
      setDismissFail({ id, msg: String(e?.message ?? e).replace(/^.*? failed: \d+ — /, '') });
      // Only re-open the request that failed; a late rejection must not expand a newer one.
      setMinimizedFor((m) => (m === id ? null : m));
    }
  };

  // On success the request leaves 'pending' and the banner closes by itself. On failure it
  // stays, so say why (the route's { error } text) instead of the old silent `void` drop.
  const submit = async (raw = cb) => {
    // Safari's address bar copies `localhost:39461/…` without its scheme. The daemon adds it
    // too, but doing it here works against a daemon that predates that fix.
    const trimmed = raw.trim();
    if (!trimmed || busy) return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    setBusy(true);
    setErr(null);
    try {
      await api.forwardAuthCallback(req.id, url);
      setCb('');
    } catch (e: any) {
      setErr(String(e?.message ?? e).replace(/^.*? failed: \d+ — /, ''));
    } finally {
      setBusy(false);
    }
  };

  // A plain link has no OAuth callback to relay back, so the paste field would only confuse.
  const signIn = isSignIn(req);
  const title = signIn ? 'Authentication required' : 'Link to open';

  // The phone header is calc(50px + env(safe-area-inset-top)) tall, so on a phone the card
  // starts under it (header and tab bar stay tappable) and spans the width instead of
  // floating centred at top:48 over the nav. Desktop keeps its centred overlay.
  const belowHeader = 'calc(50px + env(safe-area-inset-top) + 6px)';
  const tap = isMobile ? 44 : undefined;
  const tapBtn = (b: React.CSSProperties): React.CSSProperties => (tap ? { ...b, height: 'auto', minHeight: tap, minWidth: tap } : b);
  const label = agentLabel ? `${title} — ${agentLabel}` : title;
  const frame: React.CSSProperties = isMobile
    ? { position: 'fixed', top: belowHeader, left: 8, right: 8, zIndex: 200 }
    : { position: 'fixed', top: 48, left: '50%', transform: 'translateX(-50%)', zIndex: 200, width: 560, maxWidth: '92vw' };
  const dismissLabel = pending.length > 1 ? 'Dismiss all' : 'Dismiss';

  if (minimized) {
    // A small pill so the user can keep working while the sign-in is pending. Tapping the
    // label opens the card again; Dismiss stays one tap away.
    return (
      <div data-testid="auth-banner" style={{ ...frame, ...(isMobile ? { left: 'auto' } : { left: 'auto', right: 16, transform: 'none' }), maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 4, background: '#1B1B1E', border: '1px solid #4A3D18', borderRadius: 22, padding: 2, boxShadow: '0 8px 24px -8px rgba(0,0,0,.8)' }}>
        <button
          onClick={() => setMinimizedFor(null)}
          aria-label={`${signIn ? 'Sign-in pending' : 'Link to open'}${agentLabel ? ` — ${agentLabel}` : ''}`}
          style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, minHeight: 44, padding: '0 10px 0 12px', background: 'none', border: 'none', color: 'var(--color-text-primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
        >
          <span>{signIn ? '🔑' : '🔗'}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {signIn ? 'Sign-in pending' : 'Link to open'}{agentLabel ? ` — ${agentLabel}` : ''}{pending.length > 1 ? ` (${pending.length})` : ''}
          </span>
        </button>
        <button onClick={() => void dismissAll()} aria-label={dismissLabel} style={{ ...tapBtn(ghost), minHeight: 44, minWidth: 44, borderRadius: 22, flexShrink: 0 }}>✕</button>
      </div>
    );
  }

  return (
    <div
      data-testid="auth-banner"
      style={{
        ...frame,
        boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflowX: 'hidden',
        // Leave the tab bar and some thread visible: the body scrolls, the buttons do not.
        maxHeight: isMobile ? 'calc(100dvh - 50px - env(safe-area-inset-top) - 150px)' : undefined,
        background: '#1B1B1E', border: '1px solid #4A3D18', borderRadius: 12, padding: 14, boxShadow: '0 20px 60px -20px rgba(0,0,0,.8)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ color: 'var(--color-status-yellow)' }}>{signIn ? '🔑' : '🔗'}</span>
        <span style={{ fontWeight: 600, fontSize: 13, minWidth: 0, overflowWrap: 'anywhere' }}>{label}</span>
        {pending.length > 1 && (
          <span style={{ font: '500 11px var(--font-mono)', color: 'var(--color-text-tertiary)', flexShrink: 0 }}>1 of {pending.length}</span>
        )}
        <button onClick={() => setMinimizedFor(req.id)} aria-label="Minimize" title="Minimize" style={{ marginLeft: 'auto', flexShrink: 0, ...tapBtn(ghost) }}>
          –
        </button>
        {/* Dismiss clears the whole queue, not just the top one: a burst used to cost one
            tap each, with the next appearing the instant you cleared the last. */}
        <button onClick={() => void dismissAll()} style={{ flexShrink: 0, ...tapBtn(ghost) }}>
          {dismissLabel}
        </button>
      </div>
      {dismissErr && <div role="alert" style={{ marginTop: 6, fontSize: 11, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>{dismissErr}</div>}
      <div data-testid="auth-banner-body" style={{ minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
        <div data-testid="auth-banner-url" style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-secondary)', margin: '8px 0', wordBreak: 'break-all', overflowWrap: 'anywhere' }}>{req.url}</div>
        {/* A real anchor (not window.open) so a PWA opens the SYSTEM browser — Safari
            on iOS, the default browser on Mac — instead of an in-app browser. On the
            daemon's own device the localhost OAuth callback then returns automatically. */}
        <a
          href={req.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => { void api.markAuthOpened(req.id); }}
          style={{ ...primary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', lineHeight: '30px', ...(tap ? { height: 'auto', minHeight: tap } : null) }}
        >
          Open in browser ↗
        </a>
        {signIn && (
          <>
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--color-text-tertiary)' }}>On this Mac it returns automatically. From another device (e.g. iPhone), copy the <code>localhost</code> URL Safari lands on and paste it here:</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              {/* Pasting IS the action: a phone user's only step is paste, so forward on paste
                  rather than making them find and tap Forward as well. */}
              <input
                value={cb}
                onChange={(e) => setCb(e.target.value)}
                onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t.trim()) { e.preventDefault(); setCb(t.trim()); void submit(t); } }}
                onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
                placeholder="http://localhost:…/callback?code=…"
                autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url"
                // 16px on a phone: anything smaller makes iOS zoom the page on focus.
                style={{ flex: 1, minWidth: 0, height: tap ?? 30, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)', fontWeight: 400, fontSize: isMobile ? 16 : 11 }}
              />
              <button onClick={() => void submit()} disabled={busy} style={{ flexShrink: 0, ...tapBtn(ghost) }}>{busy ? 'Forwarding…' : 'Forward'}</button>
            </div>
            {err && <div role="alert" style={{ marginTop: 6, fontSize: 11, color: 'var(--color-status-red)', overflowWrap: 'anywhere' }}>{err}</div>}
          </>
        )}
      </div>
    </div>
  );
}
