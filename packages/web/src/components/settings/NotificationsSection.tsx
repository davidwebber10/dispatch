import { useEffect, useState } from 'react';
import { useSettings } from '../../stores/settings';
import { UsageAlertSetting } from './UsageLimitsSection';
import { PushSubscriptionsList } from './PushSubscriptionsList';
import { sectionLabel, row, item, Divider, Toggle } from './ui';

const note: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)' };

/**
 * Settings → Notifications. THIS DEVICE: whether this browser or phone receives push. ALL DEVICES:
 * which alerts the daemon sends beyond the per-thread bell (the usage-limit warning), and the list of
 * devices that receive them.
 */
export function NotificationsSection() {
  const pushEnabled = useSettings((s) => s.pushEnabled);
  const [pushMsg, setPushMsg] = useState('');

  // Opening Settings: if the owner revoked this device, its switch is still on. Check and turn it off.
  useEffect(() => { void import('../../lib/push').then((m) => m.syncEnrollment()).catch(() => {}); }, []);

  async function togglePush() {
    setPushMsg('');
    try { await useSettings.getState().setPushEnabled(!pushEnabled); }
    catch (e: any) {
      const { pushErrorMessage } = await import('../../lib/push');
      setPushMsg(pushErrorMessage(String(e?.message)));
    }
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={sectionLabel}>THIS DEVICE</span>
        <div style={row}><span style={item}>Push notifications on this device</span><Toggle on={pushEnabled} label="Push notifications on this device" onClick={() => void togglePush()} /></div>
        <div style={note}>Alerts are armed per thread with the bell. This lets this device receive them.</div>
        {pushMsg && <div style={note}>{pushMsg}</div>}
      </div>
      <Divider />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={sectionLabel}>ALL DEVICES</span>
        <UsageAlertSetting />
      </div>
      <Divider />

      <PushSubscriptionsList />
    </>
  );
}
