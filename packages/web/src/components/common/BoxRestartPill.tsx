import { useBoxRestart } from '../../lib/boxRestart';

/** The quiet "Reconnecting…" pill while a hosted box restarts (lib/boxRestart.ts). Token-styled, no layout assumptions. */
export function BoxRestartPill() {
  const down = useBoxRestart((s) => s.down);
  if (!down) return null;
  return (
    <div role="status" aria-live="polite" data-testid="box-restart" style={{
      position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 1000,
      padding: '6px 14px', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)',
      color: 'var(--color-text-secondary)', fontSize: 12.5,
    }}>
      Reconnecting…
    </div>
  );
}
