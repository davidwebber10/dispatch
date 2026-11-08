import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { BASE } from '../../lib/basePath';
import { useIsMobile } from '../../hooks/useIsMobile';
import { DevicesList } from './DevicesList';
import { SettingsPage, SettingsGroup, SettingsRow, SettingsDisclosure, fieldFor, solidBtn, ghostBtn, codeChip } from './ui';
import { useSectionSubPage } from './useSectionSubPage';

/**
 * Settings → Devices & access: sign in another device (network exposure spec, 8.1, first slice).
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
 *
 * 2026-11-07 (docs/design/settings-layout.md): a "Sign in a phone" group (the address as an input
 * row, then the code row), the "Signed-in devices" group (DevicesList: list rows, each device's
 * page holds Rename and Revoke), and the token's details closed in a disclosure.
 */
export const PAIR_ADDRESS_KEY = 'dispatch:pairAddress';

/**
 * localhost, any 127.x.y.z address, ::1, the unspecified address, or an IPv4-mapped form of those
 * (a browser's URL parser rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`). On a phone all of
 * these mean the phone itself.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h === '::1' || h === '::' || h === '0.0.0.0') return true;
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const hex = /^([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(mapped[1]);
    return hex ? parseInt(hex[1], 16) >> 8 === 127 : isLoopbackHost(mapped[1]);
  }
  return /^127(\.\d{1,3}){3}$/.test(h);
}

function hostOfAddress(address: string): string | null {
  try { return new URL(address.includes('://') ? address : `http://${address}`).hostname; } catch { return null; }
}
export const isLoopbackAddress = (address: string): boolean => {
  const h = hostOfAddress(address);
  return h !== null && isLoopbackHost(h);
};

/** The page's own scheme, port and base path, with the host swapped for one the phone can reach. */
export function phoneAddress(loc: { protocol: string; port: string }, host: string, base: string): string {
  return `${loc.protocol}//${host}${loc.port ? `:${loc.port}` : ''}${base}`;
}

function pageIsLoopback(): boolean {
  try { return isLoopbackHost(location.hostname); } catch { return false; }
}

function defaultAddress(): string {
  try {
    // A saved loopback address is useless on a phone, so it counts as unset.
    const saved = localStorage.getItem(PAIR_ADDRESS_KEY);
    if (saved && !isLoopbackAddress(saved)) return saved;
  } catch { /* ignore */ }
  try { return `${location.origin}${BASE}`; } catch { return ''; }
}

/** True when the user already chose an address (a saved one that a phone can use). */
function hasChosenAddress(): boolean {
  try {
    const saved = localStorage.getItem(PAIR_ADDRESS_KEY);
    return !!saved && !isLoopbackAddress(saved);
  } catch { return false; }
}

/** The link the QR code carries: the address plus the code in the fragment, which browsers never send to a server. */
export function pairLink(address: string, code: string): string {
  return `${address.trim().replace(/\/+$/, '')}/#code=${encodeURIComponent(code)}`;
}

export function AccessSection() {
  const [address, setAddress] = useState(defaultAddress);
  // This page is open on localhost, which a phone cannot use. Ask the daemon for an address it can,
  // unless the user already chose one. 'auto' = filled in for them; 'none' = nothing found.
  const loopbackPage = useState(pageIsLoopback)[0];
  const [auto, setAuto] = useState<null | 'tailscale' | 'lan' | 'none'>(null);
  const typed = useRef(hasChosenAddress());
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
    // Loaded on demand: the QR library is not needed at launch.
    import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(pairLink(address, live.code), { width: 220, margin: 1 }))
      .then((url) => { if (on) setQr(url); })
      .catch(() => { if (on) setQr(null); });
    return () => { on = false; };
  }, [live, address]);

  useEffect(() => {
    if (!loopbackPage || typed.current) return;
    let on = true;
    api.getAccessAddresses()
      .catch(() => ({ tailscale: [] as string[], lan: [] as string[] }))
      .then((r) => {
        if (!on || typed.current) return;
        const ts = r.tailscale[0];
        const lan = r.lan[0];
        const host = ts ?? lan;
        if (!host) { setAuto('none'); return; }
        setAddress(phoneAddress(location, host, BASE));
        setAuto(ts ? 'tailscale' : 'lan');
      });
    return () => { on = false; };
  }, [loopbackPage]);

  function saveAddress(v: string) {
    typed.current = true;
    setAuto(null);
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
  const isMobile = useIsMobile();
  const page = useSectionSubPage('devices');
  const subPage = page.openId !== null;
  const note: React.CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-tertiary)' };

  const tokenDisclosure = (
    <SettingsDisclosure label="Access token" hint="The key behind every sign-in. It is never shown here.">
      <SettingsRow label="Print it" hint="In a terminal on this computer, not in a Dispatch thread." control={<span style={codeChip}>dispatch access</span>} />
      <SettingsRow label="Make a new one" hint="Signs out every device at once." control={<span style={codeChip}>dispatch access rotate</span>} />
    </SettingsDisclosure>
  );

  return (
    <SettingsPage intro={subPage ? undefined : 'A phone or another computer signs in once, with a code from here. This computer needs no sign-in.'}>
      {!subPage && (
        <SettingsGroup title="Sign in a phone"
          footer={<span data-testid="address-tailscale-note">A phone on the Tailscale address needs no sign-in and is not listed. Use the Wi-Fi address to list it.</span>}>
          <SettingsRow label="Address the phone will use" hint="It goes into the QR code. Use one the phone can reach.">
            <input
              aria-label="Address the phone will use"
              value={address}
              onChange={(e) => saveAddress(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              placeholder="https://dispatch.example.com"
              style={{ ...fieldFor(isMobile), width: '100%', fontFamily: 'var(--font-mono)' }}
            />
            {loopbackPage && auto && (
              <div data-testid="loopback-note" style={{ ...note, marginTop: -2 }}>
                {auto === 'none'
                  ? 'A phone cannot open localhost, and no other address was found. Type the address the phone will use.'
                  : `A phone cannot open localhost, so Dispatch filled in this computer's ${auto === 'tailscale' ? 'Tailscale' : 'Wi-Fi'} address.`}
              </div>
            )}
          </SettingsRow>
          <SettingsRow label="Sign-in code" hint="Works once, for 5 minutes."
            control={(
              <button type="button" disabled={busy} onClick={() => void makeCode()} style={solidBtn(!busy)}>
                {live ? 'New code' : 'Make a code'}
              </button>
            )}>
            {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</div>}
            {live && (
              <div
                data-testid="pair-code-card"
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '18px 14px 14px',
                  background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)',
                }}
              >
                <div data-testid="pair-code" style={{ font: '600 28px var(--font-mono)', letterSpacing: '3px', color: 'var(--color-text-primary)', userSelect: 'all', whiteSpace: 'nowrap' }}>{live.code}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: -6 }}>Expires in {mm}:{ss}. One use.</div>
                {/* literal color: a QR code needs a white quiet zone to scan, in every theme */}
                {qr && <img src={qr} alt="QR code: scan with the phone's camera to sign in" width={180} height={180} style={{ borderRadius: 'var(--radius-md)', background: '#fff', padding: 6, flexShrink: 0 }} />}
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-text-secondary)', alignSelf: 'stretch', overflowWrap: 'anywhere' }}>
                  <li>Scan the QR code with the phone's camera and open the link.</li>
                  <li>Or open <span style={{ fontFamily: 'var(--font-mono)' }}>{address.trim() || 'the address'}</span> on the phone, tap <b>Enter a code</b>, and type the code.</li>
                </ol>
                <button type="button" style={{ ...ghostBtn, alignSelf: 'flex-end' }} onClick={() => { setPair(null); setError(null); }}>Clear code</button>
              </div>
            )}
          </SettingsRow>
        </SettingsGroup>
      )}
      <DevicesList openId={page.openId} onOpen={page.open} onClose={page.close} backLink={page.backLink} extra={tokenDisclosure} />
    </SettingsPage>
  );
}
