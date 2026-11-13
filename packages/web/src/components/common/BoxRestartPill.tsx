import { useBoxRestart } from '../../lib/boxRestart';

/**
 * The quiet "Reconnecting…" pill while a hosted workspace restarts (lib/boxRestart.ts). Token-styled,
 * no layout assumptions. After 3 minutes one plain line is added. No machine words: the person never
 * sees the lifecycle of the workspace.
 */
export function BoxRestartPill() {
  const down = useBoxRestart((s) => s.down);
  const slow = useBoxRestart((s) => s.slow);
  if (!down) return null;
  return (
    <div role="status" aria-live="polite" data-testid="box-restart" style={{
      position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 1000,
      padding: '6px 14px', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)',
      color: 'var(--color-text-secondary)', fontSize: 12.5, textAlign: 'center',
    }}>
      Reconnecting…
      {slow && <div data-testid="box-restart-slow" style={{ marginTop: 2, fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>This takes longer than usual.</div>}
    </div>
  );
}
