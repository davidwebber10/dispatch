import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { sectionLabel, row, item, Toggle, Divider } from './ui';

/**
 * Settings → About & updates: the anonymous usage stats switch (a daemon setting, so all devices).
 * Renders nothing, divider and heading included, until the daemon answers.
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
    <>
      <Divider />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>USAGE STATS</span>
        <div style={row}>
          <span style={item}>Send anonymous usage stats</span>
          <Toggle on={on} onClick={flip} label="Send anonymous usage stats" />
        </div>
      </div>
    </>
  );
}
