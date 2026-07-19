import { ArrowCircleUp } from '@phosphor-icons/react';
import { Spinner } from '../common/Spinner';
import { useUpdate } from '../../stores/update';
import { useApplyUpdate } from './useApplyUpdate';

const primary: React.CSSProperties = { height: 38, padding: '0 18px', background: 'var(--color-accent)', border: 'none', borderRadius: 10, color: '#08240F', fontWeight: 600, fontSize: 13.5, cursor: 'pointer' };
const ghost: React.CSSProperties = { height: 38, padding: '0 16px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 10, color: 'var(--color-text-secondary)', fontSize: 13.5, cursor: 'pointer' };

/**
 * Update prompt as a CENTERED, dismissable modal. The old top-anchored banner
 * sat in the PWA's status-bar / Dynamic Island zone and was unreadable there;
 * a centered card works in every context. While the update runs, the card
 * switches to a progress state and useApplyUpdate reloads the page once the
 * daemon returns with the new version.
 */
export function UpdateModal() {
  const available = useUpdate((s) => s.available);
  const dismissedVersion = useUpdate((s) => s.dismissedVersion);
  const currentVersion = useUpdate((s) => s.currentVersion);
  const { apply, applying, failReason, failDirty, failDirtyOverflow, canForce, inProgress } = useApplyUpdate();

  if (!inProgress && (!available || available.version === dismissedVersion)) return null;

  const dismiss = () => useUpdate.getState().dismiss();

  return (
    <div
      onClick={inProgress ? undefined : dismiss}
      style={{ position: 'fixed', inset: 0, zIndex: 280, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))' }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 340, maxWidth: '100%', background: '#1B1B1E', border: '1px solid #2C3A4A', borderRadius: 16, padding: '22px 20px', boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)', textAlign: 'center' }}>
        {inProgress ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}><Spinner size={26} /></div>
            <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-text-primary)' }}>Updating Dispatch…</div>
            <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
              The server is restarting — this page will refresh automatically when it's back.
            </div>
          </>
        ) : (
          <>
            <ArrowCircleUp size={34} weight="fill" color="var(--color-accent)" />
            <div style={{ marginTop: 8, fontWeight: 600, fontSize: 16, color: 'var(--color-text-primary)' }}>Update available</div>
            <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
              Dispatch {available!.version} is ready to install{currentVersion ? <> — you're on v{currentVersion}</> : null}.
            </div>
            {failReason && (
              <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-secondary)', textAlign: 'left', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 9, padding: '9px 11px' }}>
                Couldn't update automatically: {failReason}
                <br />
                Run it manually instead: <code style={{ font: '400 11px var(--font-mono)' }}>dispatch update</code>
                {failDirty && failDirty.length > 0 && (
                  <div style={{ marginTop: 8, maxHeight: 136, overflowY: 'auto', font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', background: 'rgba(0,0,0,.2)', border: '1px solid #2C2C32', borderRadius: 6, padding: '6px 8px' }}>
                    {failDirty.map((d, i) => (
                      {/* `pre` on the code only: porcelain codes carry a meaningful leading
                          space (' M' vs '??'), which HTML would collapse and misalign. */}
                      <div key={i}><span style={{ whiteSpace: 'pre' }}>{d.status}</span> {d.path}</div>
                    ))}
                    {failDirtyOverflow > 0 && <div>+{failDirtyOverflow} more</div>}
                  </div>
                )}
                {canForce && (
                  <div style={{ marginTop: 10 }}>
                    <button onClick={() => void apply(true)} disabled={applying} style={{ ...ghost, opacity: applying ? 0.7 : 1 }}>Update anyway</button>
                  </div>
                )}
              </div>
            )}
            <div style={{ marginTop: 18, display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={dismiss} style={ghost}>Later</button>
              <button onClick={() => void apply()} disabled={applying} style={{ ...primary, opacity: applying ? 0.7 : 1 }}>{applying ? 'Updating…' : 'Update'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
