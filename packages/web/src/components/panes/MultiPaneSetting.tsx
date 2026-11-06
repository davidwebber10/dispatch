import { useSettings } from '../../stores/settings';
import { row, item, Toggle } from '../settings/ui';

/** Settings → Appearance → LAYOUT: the multi-pane tabs switch (this device). */
export function MultiPaneSetting() {
  const multiPane = useSettings((s) => s.multiPane);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={row}>
        <span style={item}>Multi-pane tabs (Operator)</span>
        <Toggle
          on={multiPane}
          label="Multi-pane tabs (Operator)"
          onClick={() => useSettings.getState().setMultiPane(!multiPane)}
        />
      </div>
      <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
        Drag to rearrange, merge tabs into split-pane groups.
      </span>
    </div>
  );
}
