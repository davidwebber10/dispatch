export function Spinner({ size = 11, color = 'var(--color-accent)' }: { size?: number; color?: string }) {
  return (
    <span
      aria-label="loading"
      style={{
        display: 'inline-block', width: size, height: size, borderRadius: '50%',
        border: '1.5px solid rgba(255,255,255,0.16)', borderTopColor: color,
        animation: 'dispatchSpin 0.7s linear infinite', flexShrink: 0, boxSizing: 'border-box',
      }}
    />
  );
}
