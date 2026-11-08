import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { SettingsGroup, SettingsRow, Toggle } from './ui';

/**
 * Settings → About & updates: the anonymous usage stats switch (a daemon setting, so all devices).
 * Renders nothing, group included, until the daemon answers.
 */
export function TelemetrySetting() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { api.getTelemetrySetting().then((s) => setOn(s.enabled)).catch(() => setOn(null)); }, []);
  const flip = () => {
    if (on === null) return;
    const next = !on;
    setOn(next);
    api.setTelemetrySetting(next).then((s) => setOn(s.enabled)).catch(() => setOn(!next));
  };
  if (on === null) return null;
  return (
    <SettingsGroup title="Usage stats">
      <SettingsRow label="Send anonymous usage stats" hint="Counts only: never text, paths or names."
        control={<Toggle on={on} onClick={flip} label="Send anonymous usage stats" />} />
    </SettingsGroup>
  );
}
