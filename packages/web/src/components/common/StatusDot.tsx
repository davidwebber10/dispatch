type State = 'working' | 'idle' | 'needs_input' | 'error' | 'disabled';

const MAP: Record<State, { background: string; border: string; animation: string; opacity: number }> = {
  working:     { background: 'var(--color-accent)', border: 'none', animation: 'dispatchPulse 2s ease-in-out infinite', opacity: 1 },
  needs_input: { background: 'var(--color-status-yellow)', border: 'none', animation: 'dispatchGlow 1.6s ease-in-out infinite', opacity: 1 },
  error:       { background: 'var(--color-status-red)', border: 'none', animation: 'none', opacity: 1 },
  idle:        { background: 'transparent', border: '1.5px solid #46464D', animation: 'none', opacity: 1 },
  disabled:    { background: 'transparent', border: '1.5px solid #34343a', animation: 'none', opacity: 0.6 },
};

export function StatusDot({ state, size = 8 }: { state: State; size?: number }) {
  const s = MAP[state];
  return (
    <span
      aria-label={`status-${state}`}
      style={{
        display: 'inline-block', width: size, height: size, borderRadius: '50%',
        background: s.background, border: s.border, animationName: s.animation.split(' ')[0],
        animation: s.animation === 'none' ? undefined : s.animation, opacity: s.opacity, flexShrink: 0,
      }}
    />
  );
}
