import { useHint } from '../../stores/hint';

/** Fixed bottom-center transient hint. Mounted once per shell; renders nothing
 *  when idle. pointer-events: none — it must never intercept a tap. */
export function HintToast() {
  const msg = useHint((s) => s.msg);
  if (!msg) return null;
  return (
    <div style={{
      position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(24px + env(safe-area-inset-bottom))', zIndex: 400,
      maxWidth: 'min(92vw, 480px)', background: 'rgba(10,10,12,.92)', border: '1px solid #2C2C32',
      color: 'var(--color-text-primary)', fontSize: 13, fontWeight: 500, padding: '9px 14px', borderRadius: 10,
      boxShadow: '0 12px 30px -12px rgba(0,0,0,.7)', pointerEvents: 'none', textAlign: 'center',
    }}>
      {msg}
    </div>
  );
}
