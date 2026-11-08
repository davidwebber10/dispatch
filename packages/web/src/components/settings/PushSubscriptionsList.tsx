import { useCallback, useEffect, useState } from 'react';
import { Desktop, DeviceMobile, DeviceTablet } from '@phosphor-icons/react';
import { api, type PushSubscriptionInfo } from '../../api/client';
import { deviceId, syncEnrollment } from '../../lib/push';
import { timeAgo } from '../../lib/time';
import { useSettings } from '../../stores/settings';
import { ConfirmModal } from '../common/ConfirmModal';
import { SettingsGroup, SettingsRow, EmptyState, ghostBtn, miniChip } from './ui';

/**
 * Settings → Notifications: devices that receive push notifications (all devices).
 *
 * Each row is a browser or phone that turned notifications on. Revoke (after a confirm) removes that one
 * subscription, so the daemon stops sending to it. The row shows the push service host (for example
 * web.push.apple.com), never the full push address. This is separate from signed-in devices: a device can
 * hold either or both.
 */
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** A device icon from the label the browser gave itself ("iPhone · Safari", "Mac · Chrome"). */
function deviceIcon(label: string) {
  if (/ipad|tablet/i.test(label)) return DeviceTablet;
  if (/iphone|android|phone|mobile/i.test(label)) return DeviceMobile;
  return Desktop;
}

const TITLE = 'Devices that get alerts';
const bare: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };

export function PushSubscriptionsList({ now = Date.now }: { now?: () => number }) {
  const [subs, setSubs] = useState<PushSubscriptionInfo[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pending, setPending] = useState<PushSubscriptionInfo | null>(null);
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
    setPending(null);
    setBusy(true); setError(null);
    try {
      await api.revokePushSubscription(s.deviceId);
      // This browser lost its subscription: turn its notification switch off and drop the browser-side one too.
      if (s.deviceId === mine) { try { await useSettings.getState().setPushEnabled(false); } catch { /* the daemon side is already gone */ } }
      await load();
    } catch {
      setError(`Could not revoke ${s.label}. Try again.`);
    } finally { setBusy(false); }
  }

  const t = now();

  if (state === 'loading') return <SettingsGroup title={TITLE}><SettingsRow label="Loading…" /></SettingsGroup>;
  if (state === 'error' || !subs) {
    return (
      <section role="group" aria-label={TITLE} style={bare}>
        <EmptyState action={<button type="button" style={ghostBtn} onClick={() => void load()}>Try again</button>}>Could not load the devices that get alerts.</EmptyState>
      </section>
    );
  }
  if (subs.length === 0) {
    return (
      <section role="group" aria-label={TITLE} style={bare}>
        <EmptyState>No device gets alerts yet. Turn on push notifications above on each phone or computer.</EmptyState>
      </section>
    );
  }

  return (
    <>
      <SettingsGroup title={TITLE}
        footer={error ? <span role="alert" style={{ color: 'var(--color-status-red)' }}>{error}</span> : 'Revoke stops alerts to one device. It can turn them on again in its own Settings.'}>
        {subs.map((s) => (
          <div key={s.deviceId} data-testid="push-row" title={`Added ${day(s.createdAt)}`}>
            <SettingsRow
              icon={deviceIcon(s.label)}
              label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{s.label}{s.deviceId === mine && <span style={{ ...miniChip, color: 'var(--color-accent)' }}>This device</span>}</span>}
              hint={<>{s.lastSentAt ? `Last alert ${timeAgo(s.lastSentAt, t)} ago` : 'No alert yet'} · <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{s.host}</span></>}
              control={<button type="button" disabled={busy} aria-label={`Revoke ${s.label}`} style={{ ...ghostBtn, height: 28 }} onClick={() => setPending(s)}>Revoke</button>}
            />
          </div>
        ))}
      </SettingsGroup>
      <ConfirmModal open={!!pending} danger title={`Stop alerts to ${pending?.label ?? ''}?`} confirmLabel="Revoke"
        message="That device stops getting alerts at once. It can turn them on again in its own Settings."
        onConfirm={() => { if (pending) void revoke(pending); }} onCancel={() => setPending(null)} />
    </>
  );
}
