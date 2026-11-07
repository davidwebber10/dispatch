import { useHint } from '../../stores/hint';

/** Fixed bottom-center transient hint. Mounted once per shell; renders nothing
 *  when idle. pointer-events: none — it must never intercept a tap. */
export function HintToast() {
  const msg = useHint((s) => s.msg);
  if (!msg) return null;
  return (
    <div style={{
      position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(24px + env(safe-area-inset-bottom))', zIndex: 400,
      maxWidth: 'min(92vw, 480px)', background: 'color-mix(in srgb, var(--color-base) 92%, transparent)', border: '1px solid var(--color-border-strong)',
      color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 500, padding: '9px 14px', borderRadius: 'var(--radius-md)',
      boxShadow: '0 12px 30px -12px var(--color-shadow)', pointerEvents: 'none', textAlign: 'center',
    }}>
      {msg}
    </div>
  );
}
