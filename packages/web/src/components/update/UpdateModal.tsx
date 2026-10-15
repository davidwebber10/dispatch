import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowCircleUp } from '@phosphor-icons/react';
import { IDLE_RELOAD_MS, UpdateBadge, UpdateDone, UpdateDoneBadge, UpdateFailed, UpdateRunning, pageReload, useUpdateProgressPoller } from './UpdateProgress';
import { useUpdate } from '../../stores/update';
import { useApplyUpdate } from './useApplyUpdate';
import { ReleaseNotes } from './ReleaseNotes';
import { Blaster, blasterActivity } from './blaster/Blaster';

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
  const notes = useUpdate((s) => s.notes);
  const { apply, applying, failReason, failDirty, failDirtyOverflow, canForce, inProgress, hosted } = useApplyUpdate();
  const runFailed = useUpdate((s) => s.runFailed);
  const hidden = useUpdate((s) => s.progressHidden);
  const doneVersion = useUpdate((s) => s.doneVersion);
  const doneAt = useUpdate((s) => s.doneAt);
  const donePlaying = useUpdate((s) => s.donePlaying);
  useUpdateProgressPoller();
  // The card is a narrow prompt until the notes open, then it widens to stay readable.
  const [notesOpen, setNotesOpen] = useState(false);
  // The status card is the arena's wall.
  const cardRef = useRef<HTMLDivElement>(null);
  const getWall = useCallback(() => {
    const r = cardRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  }, []);
  const done = doneVersion !== null;

  // Done: reload after a quiet spell, so a phone on the table does not stay on the old version.
  useEffect(() => {
    if (!done || doneAt === null) return;
    const t = setInterval(() => {
      if (Date.now() - Math.max(doneAt, blasterActivity.last) >= IDLE_RELOAD_MS) { clearInterval(t); pageReload.run(); }
    }, 1000);
    return () => clearInterval(t);
  }, [done, doneAt]);

  if (inProgress && hidden) return <UpdateBadge />;
  if (!inProgress && !runFailed && !done && (!available || available.version === dismissedVersion)) return null;
  const arena = inProgress || runFailed || done;

  const dismiss = () => useUpdate.getState().dismiss();

  return (
    <div
      onClick={arena ? undefined : dismiss}
      style={{ position: 'fixed', inset: 0, zIndex: 280, background: arena ? 'transparent' : 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))' }}
    >
      {/* While the update runs, the backdrop is the game arena, and the card becomes liquid
          glass — translucent, backdrop-blurred — so the game stays visible behind it. The
          blur keeps the text readable over the moving ships. */}
      {/* The waiting game: the arena fills the screen, and the card below is its wall. A
          failure pauses it; after "Keep playing" the card is gone and the arena is open. */}
      {arena && <Blaster getWall={donePlaying ? noWall : getWall} paused={runFailed} />}
      {done && donePlaying ? <UpdateDoneBadge /> : (
      <div
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: arena ? 380 : notesOpen ? 460 : 340,
          maxWidth: '100%',
          transition: 'width .18s ease',
          // Glass, not smoked glass: a low fill alpha and a MODERATE blur — 22px averaged the
          // arena into a flat wash, so the card read as near-opaque however low the fill went.
          // At ~10px individual glyph streaks stay recognizably falling behind the text.
          background: arena ? 'rgba(27,27,30,.55)' : '#1B1B1E',
          ...(arena ? { backdropFilter: 'blur(10px) saturate(1.4)', WebkitBackdropFilter: 'blur(10px) saturate(1.4)' } : {}),
          // A faint light edge reads as a glass rim; the idle prompt keeps its solid border.
          border: arena ? '1px solid rgba(255,255,255,.14)' : '1px solid #2C3A4A',
          borderRadius: 16,
          padding: '22px 20px',
          boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)',
          textAlign: 'center',
        }}>
        {done ? (
          <UpdateDone />
        ) : inProgress ? (
          <UpdateRunning />
        ) : runFailed ? (
          <UpdateFailed onRetry={() => void apply()} retrying={applying} />
        ) : (
          <>
            <ArrowCircleUp size={34} weight="fill" color="var(--color-accent)" />
            <div style={{ marginTop: 8, fontWeight: 600, fontSize: 16, color: 'var(--color-text-primary)' }}>Update available</div>
            <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
              Dispatch {available!.version} is ready to install{currentVersion ? <> — you're on v{currentVersion}</> : null}.
            </div>
            <ReleaseNotes notes={notes} onToggle={setNotesOpen} />
            {failReason && (
              <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-secondary)', textAlign: 'left', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 9, padding: '9px 11px' }}>
                Couldn't update automatically: {failReason}
                <br />
                {/* A hosted workspace has no checkout and no shell, so the manual
                    command is advice the reader cannot follow. */}
                {hosted
                  ? 'Your workspace updates when it is rebuilt onto a newer image — ask an administrator if this keeps failing.'
                  : <>Run it manually instead: <code style={{ font: '400 11px var(--font-mono)' }}>dispatch update</code></>}
                {failDirty && failDirty.length > 0 && (
                  <div style={{ marginTop: 8, maxHeight: 136, overflowY: 'auto', font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', background: 'rgba(0,0,0,.2)', border: '1px solid #2C2C32', borderRadius: 6, padding: '6px 8px' }}>
                    {/* `pre` on the status only: porcelain codes carry a meaningful leading
                        space (' M' vs '??') that HTML would collapse, misaligning the list. */}
                    {failDirty.map((d, i) => (
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
      )}
    </div>
  );
}

const noWall = () => null;
