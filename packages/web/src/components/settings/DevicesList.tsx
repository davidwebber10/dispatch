import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type DeviceInfo, type DeviceList } from '../../api/client';
import { timeAgo } from '../../lib/time';
import { sectionLabel, row, fieldInput, solidBtn, ghostBtn, miniChip } from './ui';
import { reloadFresh } from '../../lib/shellCache';

/**
 * Settings → Devices & access: signed-in devices (network exposure spec, 8.1 and 8.2).
 *
 * One row per browser or phone that signed in. Revoke ends that one device and no other. A
 * browser on the computer itself, or on the owner's own Tailscale, needs no sign-in and has no
 * row. "Signed in before the device list" rows are browsers that held the old shared cookie:
 * Dispatch gives each one its own cookie the next time it opens the app.
 */
export function addressLabel(addr: string | null, kind: DeviceInfo['addressKind']): string {
  if (!addr) return 'Unknown address';
  if (kind === 'local') return 'This computer';
  if (kind === 'gateway') return 'Windows host (WSL)';
  // A proxy on this computer reported it; Dispatch cannot check it.
  if (kind === 'forwarded') return `${addr} (via proxy)`;
  return addr;
}

const viaLabel = (v: DeviceInfo['signedInVia']) =>
  v === 'code' ? 'Signed in with a sign-in code' : v === 'token' ? 'Signed in with the access token' : 'Signed in before the device list';

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

type Pending = { id: string; kind: 'revoke' | 'rename' } | 'legacy' | null;

export function DevicesList({ now = Date.now, reload = () => { void reloadFresh(); } }: { now?: () => number; reload?: () => void }) {
  const [data, setData] = useState<DeviceList | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [pending, setPending] = useState<Pending>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.getDevices());
      setState('ready');
    } catch (e) {
      setState(e instanceof ApiError && e.status === 404 ? 'unavailable' : 'error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function revoke(d: DeviceInfo) {
    setBusy(true); setError(null);
    try {
      await api.revokeDevice(d.id);
      setPending(null);
      if (d.current) return reload(); // this browser just lost its sign-in: land on the sign-in page
      await load();
    } catch {
      setError(`Could not revoke ${d.name}. Try again.`);
    } finally { setBusy(false); }
  }

  async function rename(d: DeviceInfo) {
    const name = draft.trim();
    if (!name) return;
    setBusy(true); setError(null);
    try {
      await api.renameDevice(d.id, name);
      setPending(null);
      await load();
    } catch {
      setError('Could not rename the device. Try again.');
    } finally { setBusy(false); }
  }

  async function endLegacy() {
    setBusy(true); setError(null);
    try {
      await api.endLegacyDevices();
      setPending(null);
      await load();
    } catch {
      setError('Could not sign those devices out. Try again.');
    } finally { setBusy(false); }
  }

  const small: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5 };
  const t = now();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={sectionLabel}>SIGNED-IN DEVICES</span>
      {state === 'loading' && <div style={small}>Loading…</div>}
      {state === 'unavailable' && <div style={{ ...small, fontSize: 12.5 }}>The device list is not available on this Dispatch.</div>}
      {state === 'error' && (
        <div style={{ ...small, fontSize: 12.5 }}>
          Could not load the device list. <button type="button" style={ghostBtn} onClick={() => void load()}>Try again</button>
        </div>
      )}
      {state === 'ready' && data && (
        <>
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-text-secondary)' }}>
            Each phone or browser that signs in is listed here. Revoke ends that one device. Every other device stays signed in.
            {data.currentDeviceId === null && ' This browser needs no sign-in, so it is not in the list.'}
          </div>
          <div data-testid="tailscale-note" style={small}>
            Devices on your own Tailscale need no sign-in, so they do not appear here. Manage or remove them in the Tailscale
            admin console. To list a phone here, use the Wi-Fi address.
          </div>
          {data.devices.length === 0 && <div style={small}>No device has signed in yet.</div>}
          {data.devices.map((d) => (
            <div
              key={d.id}
              data-testid="device-row"
              style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 'var(--radius-md)' }}
            >
              <div style={{ ...row, flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  {pending && pending !== 'legacy' && pending.id === d.id && pending.kind === 'rename' ? (
                    <input
                      aria-label="Device name"
                      value={draft}
                      maxLength={60}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void rename(d); if (e.key === 'Escape') setPending(null); }}
                      style={{ ...fieldInput, width: 200 }}
                    />
                  ) : (
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' }}>{d.name}</span>
                  )}
                  {d.current && <span style={{ ...miniChip, color: 'var(--color-accent)' }}>This device</span>}
                </span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {pending && pending !== 'legacy' && pending.id === d.id && pending.kind === 'rename' ? (
                    <>
                      <button type="button" disabled={busy || !draft.trim()} style={solidBtn(!busy && !!draft.trim())} onClick={() => void rename(d)}>Save</button>
                      <button type="button" style={ghostBtn} onClick={() => setPending(null)}>Cancel</button>
                    </>
                  ) : pending && pending !== 'legacy' && pending.id === d.id && pending.kind === 'revoke' ? (
                    <>
                      <button type="button" disabled={busy} style={{ ...solidBtn(!busy), background: '#F37165', color: '#2a0a07' }} onClick={() => void revoke(d)}>
                        {d.current ? 'Yes, sign out' : 'Yes, revoke'}
                      </button>
                      <button type="button" style={ghostBtn} onClick={() => setPending(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button type="button" style={ghostBtn} onClick={() => { setDraft(d.name); setPending({ id: d.id, kind: 'rename' }); }}>Rename</button>
                      <button type="button" style={ghostBtn} onClick={() => setPending({ id: d.id, kind: 'revoke' })}>
                        {d.current ? 'Sign out this device' : 'Revoke'}
                      </button>
                    </>
                  )}
                </span>
              </div>
              {pending && pending !== 'legacy' && pending.id === d.id && pending.kind === 'revoke' && (
                <div style={{ ...small, color: '#F37165' }}>
                  {d.current
                    ? 'This will sign you out here. You will need a new code or the access token to come back.'
                    : 'That device will be signed out at once. It needs a new code or the access token to come back.'}
                </div>
              )}
              <div style={small}>
                {viaLabel(d.signedInVia)} · {addressLabel(d.lastAddress, d.addressKind)}
              </div>
              <div style={small}>
                First seen {day(d.createdAt)} · Last active {t - d.lastSeenAt < 5000 ? 'now' : `${timeAgo(new Date(d.lastSeenAt).toISOString(), t)} ago`}
              </div>
            </div>
          ))}
          {data.legacyOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              <div style={small}>
                Phones and browsers that signed in before this list existed keep working, and show up here the next time they open Dispatch.
                When you have seen all your devices appear, you can sign out any device that has not.
              </div>
              <div>
                {pending === 'legacy' ? (
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button type="button" disabled={busy} style={{ ...solidBtn(!busy), background: '#F37165', color: '#2a0a07' }} onClick={() => void endLegacy()}>Yes, sign them out</button>
                    <button type="button" style={ghostBtn} onClick={() => setPending(null)}>Cancel</button>
                    <span style={{ ...small, color: '#F37165' }}>A device that has not opened Dispatch since the update will need to sign in again.</span>
                  </span>
                ) : (
                  <button type="button" style={ghostBtn} onClick={() => setPending('legacy')}>Sign out devices not in this list</button>
                )}
              </div>
            </div>
          )}
          {error && <div role="alert" style={{ fontSize: 12.5, color: '#F37165' }}>{error}</div>}
        </>
      )}
    </div>
  );
}
