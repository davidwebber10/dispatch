export function Spinner({ size = 11, color = 'var(--color-accent)' }: { size?: number; color?: string }) {
  return (
    <span
      aria-label="loading"
      style={{
        display: 'inline-block', width: size, height: size, borderRadius: '50%',
        border: '1.5px solid rgba(255,255,255,0.16)', borderTopColor: color,
        animation: 'dispatchSpin 0.7s linear infinite', flexShrink: 0, boxSizing: 'border-box',
        // Promote to its own compositor layer. An odd-size spinner centered in an even-height
        // slot (e.g. 11px in an 18px row) sits on a half-pixel, so a plain rotate() re-samples
        // the circle against the pixel grid every frame → visible shimmer; and in the
        // live-updating thread list the animation otherwise competes with React's main-thread
        // re-renders and drops frames. A dedicated layer rasterizes the circle once and spins
        // the texture on the compositor — smooth regardless of sub-pixel origin or main-thread work.
        willChange: 'transform',
      }}
    />
  );
}
