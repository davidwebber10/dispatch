import { useEffect, useState } from 'react';
import { useSettings } from '../../stores/settings';
import { useUsageLimitSettings } from './UsageLimitsSection';
import { PushSubscriptionsList } from './PushSubscriptionsList';
import { SettingsPage, SettingsGroup, SettingsRow, Toggle } from './ui';

/** The push sent when a usage window reaches the warning level (all devices; the daemon sends it). */
function UsageAlertGroup() {
  const { cfg, err, save } = useUsageLimitSettings();
  return (
    <SettingsGroup title="Usage alerts" footer={err ? <span role="alert" style={{ color: 'var(--color-status-red)' }}>{err}</span> : undefined}>
      <SettingsRow label="Usage warning"
        hint={cfg ? `One push when a usage window reaches ${cfg.warnPercent}%. Set the level in Usage limits.` : 'Loading…'}
        control={cfg ? <Toggle on={cfg.pushOnWarn} onClick={() => save({ pushOnWarn: !cfg.pushOnWarn })} label="Push alert at the warning level" /> : null} />
    </SettingsGroup>
  );
}

/**
 * Settings → Notifications. This device: whether this browser or phone receives push. Usage alerts:
 * the alert the daemon sends beyond the per-thread bell. Then the devices that receive them.
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
    <SettingsPage intro="Arm alerts on a thread with its bell. Here you choose where they arrive.">
      <SettingsGroup title="This device">
        <SettingsRow label="Push notifications"
          hint={pushMsg ? <span role="alert" style={{ color: 'var(--color-status-yellow)' }}>{pushMsg}</span> : 'Let this device receive thread alerts.'}
          control={<Toggle on={pushEnabled} label="Push notifications on this device" onClick={() => void togglePush()} />} />
      </SettingsGroup>
      <UsageAlertGroup />
      <PushSubscriptionsList />
    </SettingsPage>
  );
}
