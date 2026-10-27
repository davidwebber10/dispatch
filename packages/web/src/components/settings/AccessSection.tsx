import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError } from '../../api/client';
import { BASE } from '../../lib/basePath';
import { sectionLabel, row, item, fieldInput, solidBtn, ghostBtn, Divider } from './ui';

/**
 * Settings → Access: sign in another device (network exposure spec, 8.1, first slice).
 *
 * Other devices see Dispatch's sign-in page until they prove they know the access token. The
 * token lives on this computer and `dispatch access` prints it, but a phone cannot type 43
 * random characters. This section asks the daemon for a one-time code (5 minutes, one use)
 * and shows it two ways: as text to type on the sign-in page, and as a QR code of
 * `ADDRESS/#code=XXXX-XXXX`, which the phone's camera opens and which signs the phone in.
 *
 * The address in the QR code is the one the PHONE will use (a tunnel hostname, a Tailscale
 * name), which is often not the address this browser is on, so it is an editable field,
 * remembered per browser. The token itself is never read over the API.
 */
export const PAIR_ADDRESS_KEY = 'dispatch:pairAddress';

function defaultAddress(): string {
  try {
    const saved = localStorage.getItem(PAIR_ADDRESS_KEY);
    if (saved) return saved;
  } catch { /* ignore */ }
  try { return `${location.origin}${BASE}`; } catch { return ''; }
}

/** The link the QR code carries: the address plus the code in the fragment, which browsers never send to a server. */
export function pairLink(address: string, code: string): string {
  return `${address.trim().replace(/\/+$/, '')}/#code=${encodeURIComponent(code)}`;
}

export function AccessSection() {
  const [address, setAddress] = useState(defaultAddress);
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Tick while a code is live, so the "expires in" line counts down and the code clears on expiry.
  useEffect(() => {
    if (!pair) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pair]);
  const live = pair && pair.expiresAt > now ? pair : null;

  useEffect(() => {
    if (!live) { setQr(null); return; }
    let on = true;
    QRCode.toDataURL(pairLink(address, live.code), { width: 220, margin: 1 })
      .then((url) => { if (on) setQr(url); })
      .catch(() => { if (on) setQr(null); });
    return () => { on = false; };
  }, [live, address]);

  function saveAddress(v: string) {
    setAddress(v);
    try { localStorage.setItem(PAIR_ADDRESS_KEY, v); } catch { /* ignore */ }
  }

  async function makeCode() {
    setBusy(true); setError(null);
    try {
      const p = await api.makePairCode();
      setNow(Date.now());
      setPair(p);
    } catch (e) {
      setPair(null);
      setError(e instanceof ApiError && e.status === 404
        ? 'Sign-in codes are not available on this Dispatch.'
        : 'Could not make a code. Try again.');
    } finally { setBusy(false); }
  }

  const secondsLeft = live ? Math.max(0, Math.ceil((live.expiresAt - now) / 1000)) : 0;
  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, '0');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={sectionLabel}>SIGN IN ANOTHER DEVICE</span>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-text-secondary)' }}>
          A phone or another computer sees a sign-in page until it signs in once. This computer and your own
          Tailscale devices need no sign-in. Make a code here, then type it on that page, or scan the QR code
          with the phone's camera. A code works once and lasts 5 minutes.
        </div>
        <div style={{ ...row, flexWrap: 'wrap' }}>
          <span style={item}>Address the phone will use</span>
          <input
            aria-label="Address the phone will use"
            value={address}
            onChange={(e) => saveAddress(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            placeholder="https://dispatch.example.com"
            style={{ ...fieldInput, flex: '1 1 220px' }}
          />
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
          The address goes into the QR code only. Use the one the phone can reach: a tunnel hostname or a Tailscale name.
        </div>
        <div style={row}>
          <span style={item}>Sign-in code</span>
          <button type="button" disabled={busy} onClick={() => void makeCode()} style={solidBtn(!busy)}>
            {live ? 'New code' : 'Make a code'}
          </button>
        </div>
        {error && <div role="alert" style={{ fontSize: 12.5, color: '#F37165' }}>{error}</div>}
        {live && (
          <div
            data-testid="pair-code-card"
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: 18,
              background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 10,
            }}
          >
            <div data-testid="pair-code" style={{ font: '600 28px var(--font-mono)', letterSpacing: '3px', color: 'var(--color-text-primary)', userSelect: 'all', whiteSpace: 'nowrap' }}>{live.code}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: -8 }}>Expires in {mm}:{ss}. One use.</div>
            {qr && <img src={qr} alt="QR code: scan with the phone's camera to sign in" width={180} height={180} style={{ borderRadius: 8, background: '#fff', padding: 6, flexShrink: 0 }} />}
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-secondary)', alignSelf: 'stretch', overflowWrap: 'anywhere' }}>
              <li>Scan the QR code with the phone's camera and open the link.</li>
              <li>Or open <span style={{ fontFamily: 'var(--font-mono)' }}>{address.trim() || 'the address'}</span> on the phone, tap <b>Enter a code</b>, and type the code.</li>
            </ol>
          </div>
        )}
      </div>
      <Divider />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>THE ACCESS TOKEN</span>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-text-secondary)' }}>
          The long-lived token stays on the computer that runs Dispatch. It is never shown here. In a terminal
          on that computer, run <span style={{ fontFamily: 'var(--font-mono)' }}>dispatch access</span> to print it, or
          <span style={{ fontFamily: 'var(--font-mono)' }}> dispatch access rotate</span> to make a new one and sign out
          every device. The command refuses to run inside a Dispatch thread.
        </div>
        <div>
          <button type="button" style={ghostBtn} onClick={() => { setPair(null); setError(null); }} disabled={!live}>
            Clear the code from this screen
          </button>
        </div>
      </div>
    </div>
  );
}
