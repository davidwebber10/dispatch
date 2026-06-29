import { useSettings } from '../../stores/settings';

// ── local style constants matching SettingsModal ───────────────────────────
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};

const itemStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#c9c9cf',
};

const descStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--color-text-tertiary)',
};

// ── Toggle — mirrors the one in SettingsModal ──────────────────────────────
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 38,
        height: 21,
        borderRadius: 11,
        border: 'none',
        cursor: 'pointer',
        background: on ? 'var(--color-accent)' : '#34343a',
        position: 'relative',
        transition: 'background .15s ease',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 19 : 2,
          width: 17,
          height: 17,
          borderRadius: '50%',
          background: on ? '#08240F' : '#e9e9ec',
          transition: 'left .15s ease',
        }}
      />
    </button>
  );
}

// ── MultiPaneSetting ───────────────────────────────────────────────────────
export function MultiPaneSetting() {
  const multiPane = useSettings((s) => s.multiPane);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={rowStyle}>
        <span style={itemStyle}>Multi-pane tabs (Operator)</span>
        <Toggle
          on={multiPane}
          onClick={() => useSettings.getState().setMultiPane(!multiPane)}
        />
      </div>
      <span style={descStyle}>
        Drag to rearrange, merge tabs into split-pane groups.
      </span>
    </div>
  );
}
