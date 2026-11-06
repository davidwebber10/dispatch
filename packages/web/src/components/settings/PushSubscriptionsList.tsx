import { useCallback, useEffect, useState } from 'react';
import { api, type PushSubscriptionInfo } from '../../api/client';
import { deviceId, syncEnrollment } from '../../lib/push';
import { timeAgo } from '../../lib/time';
import { useSettings } from '../../stores/settings';
import { sectionLabel, row, solidBtn, ghostBtn, miniChip } from './ui';

/**
 * Settings → Notifications: devices that receive push notifications (all devices).
 *
 * Each row is a browser or phone that turned notifications on. Revoke removes that one subscription, so
 * the daemon stops sending to it. The list shows the push service host (for example web.push.apple.com),
 * never the full push address. This is separate from signed-in devices: a device can hold either or both.
 */
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function PushSubscriptionsList({ now = Date.now }: { now?: () => number }) {
  const [subs, setSubs] = useState<PushSubscriptionInfo[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = deviceId();

  const load = useCallback(async () => {
    try {
      const list = (await api.getPushSubscriptions()).subscriptions;
      setSubs(list);
      setState('ready');
      void syncEnrollment(); // this device's row may be gone (revoked): turn its switch off (it reads its own fresh list)
    } catch {
      setState('error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function revoke(s: PushSubscriptionInfo) {
    setBusy(true); setError(null);
    try {
      await api.revokePushSubscription(s.deviceId);
      setPending(null);
      // This browser lost its subscription: turn its notification switch off and drop the browser-side one too.
      if (s.deviceId === mine) { try { await useSettings.getState().setPushEnabled(false); } catch { /* the daemon side is already gone */ } }
      await load();
    } catch {
      setError(`Could not revoke ${s.label}. Try again.`);
    } finally { setBusy(false); }
  }

  const small: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5 };
  const t = now();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={sectionLabel}>NOTIFICATION DEVICES</span>
      {state === 'loading' && <div style={small}>Loading…</div>}
      {state === 'error' && (
        <div style={{ ...small, fontSize: 12.5 }}>
          Could not load the notification devices. <button type="button" style={ghostBtn} onClick={() => void load()}>Try again</button>
        </div>
      )}
      {state === 'ready' && subs && (
        <>
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-text-secondary)' }}>
            Each phone or browser that turned on notifications gets thread alerts. Revoke stops alerts to that one device.
          </div>
          {subs.length === 0 && <div style={small}>No device receives notifications.</div>}
          {subs.map((s) => (
            <div
              key={s.deviceId}
              data-testid="push-row"
              style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 'var(--radius-md)' }}
            >
              <div style={{ ...row, flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' }}>{s.label}</span>
                  {s.deviceId === mine && <span style={{ ...miniChip, color: 'var(--color-accent)' }}>This device</span>}
                </span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {pending === s.deviceId ? (
                    <>
                      <button type="button" disabled={busy} style={{ ...solidBtn(!busy), background: '#F37165', color: '#2a0a07' }} onClick={() => void revoke(s)}>Yes, revoke</button>
                      <button type="button" style={ghostBtn} onClick={() => setPending(null)}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" style={ghostBtn} onClick={() => setPending(s.deviceId)}>Revoke</button>
                  )}
                </span>
              </div>
              {pending === s.deviceId && (
                <div style={{ ...small, color: '#F37165' }}>That device stops getting alerts at once. It can turn them on again in its own Settings.</div>
              )}
              <div style={small}>Push service: {s.host}</div>
              <div style={small}>
                Added {day(s.createdAt)} · {s.lastSentAt ? `Last alert ${timeAgo(s.lastSentAt, t)} ago` : 'No alert sent yet'}
              </div>
            </div>
          ))}
          {error && <div role="alert" style={{ fontSize: 12.5, color: '#F37165' }}>{error}</div>}
        </>
      )}
    </div>
  );
}
