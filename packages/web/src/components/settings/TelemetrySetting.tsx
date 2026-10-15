import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { row, item, Toggle } from './ui';

/** The last row of General: the anonymous usage stats switch (daemon setting). */
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
    <div style={row}>
      <span style={item}>Send anonymous usage stats</span>
      <Toggle on={on} onClick={flip} label="Send anonymous usage stats" />
    </div>
  );
}
