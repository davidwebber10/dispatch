// Overseer — coordinator session menu (the ⋯ kebab): Restart / New session / Previous
// sessions. Workers get Stop/Archive (AutonomyControls); the coordinator gets THIS
// instead because its semantics differ:
//   Restart          → POST /terminals/:id/relaunch — kill + respawn now, SAME
//                      conversation (`-r` resume + backfill). The respawn re-reads the
//                      MCP config, so this is the one-click "reload tools" fix.
//   New session…     → archive (soft delete) + find-or-create a fresh coordinator,
//                      via the store swap (two-step inline confirm; no window.confirm —
//                      a browser modal would block the event loop).
//   Previous sessions→ archived coordinators for this project; picking one swaps it
//                      back in (archive current FIRST — one active coordinator).
// Mounted: desktop composer row (direction 'up'), mobile header + Board coordinator
// lightbox (direction 'down'). Scheme-aware like AutonomyControls.

import { useState } from 'react';
import { api } from '../../../api/client';
import type { Terminal } from '../../../api/types';
import { useOverseer } from '../store';
import { Icon } from '../atoms';
import { SCHEMES, type Scheme, type Tokens } from './AutonomyControls';

const itemStyle = (t: Tokens, color: string): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  width: '100%',
  padding: '7px 9px',
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color,
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.2,
  textAlign: 'left' as const,
  cursor: 'pointer',
  fontFamily: 'inherit',
});

export function CoordinatorMenu({ terminalId, sessionId, scheme = 'scoped', direction = 'down' }: {
  terminalId: string;
  sessionId: string;
  scheme?: Scheme;
  direction?: 'up' | 'down';
}) {
  const t = SCHEMES[scheme];
  const newCoordinatorSession = useOverseer((s) => s.newCoordinatorSession);
  const resumeCoordinatorSession = useOverseer((s) => s.resumeCoordinatorSession);
  const [open, setOpen] = useState(false);
  const [confirmingNew, setConfirmingNew] = useState(false);
  const [previous, setPrevious] = useState<Terminal[] | null>(null); // null = list closed
  const [busy, setBusy] = useState(false);

  const close = () => { setOpen(false); setConfirmingNew(false); setPrevious(null); setBusy(false); };

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await fn();
      // newCoordinatorSession/resumeCoordinatorSession resolve an explicit `false` when
      // nothing changed (the initial archive failed) — treat that the same as a thrown
      // error: keep the menu open so the failure is visible, instead of silently closing.
      // api.relaunchTerminal resolves a Terminal object, so it never hits this branch.
      if (result === false) { setBusy(false); return; }
      close();
    }
    catch { setBusy(false); } // keep the menu open so the failure is visible
  };

  const openPrevious = async () => {
    setConfirmingNew(false);
    try {
      const all = await api.listArchivedTerminals(sessionId);
      setPrevious(all.filter((x) => x.type === 'claude-code' && x.config?.role === 'coordinator'));
    } catch {
      // Leave `previous` at null (list closed) rather than [] — an [] renders the
      // misleading "No previous sessions." empty state on a FETCH failure, when previous
      // sessions may well exist. Keeping it null keeps the "Previous sessions…" button
      // so the user can retry.
    }
  };

  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title="Session menu"
        aria-label="Session menu"
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: t.surface,
          border: `1px solid ${t.border}`,
          color: t.dim,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <Icon name="ph-dots-three" weight="bold" size={16} color={t.dim} />
      </button>

      {open && (
        <>
          {/* click-away scrim (transparent) — closes without stealing the next click's target */}
          <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 69 }} />
          <div
            style={{
              position: 'absolute',
              right: 0,
              [direction === 'up' ? 'bottom' : 'top']: 'calc(100% + 6px)',
              zIndex: 70,
              minWidth: 230,
              padding: 4,
              borderRadius: 10,
              background: t.surface,
              border: `1px solid ${t.border}`,
              boxShadow: '0 12px 32px -12px rgba(0,0,0,.6)',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              opacity: busy ? 0.7 : 1,
            }}
          >
            <button
              type="button"
              onClick={() => void run(() => api.relaunchTerminal(terminalId))}
              disabled={busy}
              title="Restart — reload tools and connections; history is kept"
              style={itemStyle(t, t.dim)}
            >
              <Icon name="ph-arrow-clockwise" size={13} color={t.dim} />
              Restart session
            </button>

            {confirmingNew ? (
              <div style={{ padding: '7px 9px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11.5, color: t.dim, lineHeight: 1.4 }}>
                  End this session? A fresh one starts now. The old conversation is archived.
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" onClick={() => void run(() => newCoordinatorSession(sessionId, terminalId))} disabled={busy}
                    style={{ ...itemStyle(t, t.danger), width: 'auto', border: `1px solid ${t.border}` }}>
                    Confirm
                  </button>
                  <button type="button" onClick={() => setConfirmingNew(false)} disabled={busy}
                    style={{ ...itemStyle(t, t.dim), width: 'auto', border: `1px solid ${t.border}` }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setPrevious(null); setConfirmingNew(true); }}
                disabled={busy}
                title="End this session and start a fresh one (the old one is archived)"
                style={itemStyle(t, t.danger)}
              >
                <Icon name="ph-sparkle" size={13} color={t.danger} />
                New session…
              </button>
            )}

            {previous === null ? (
              <button type="button" onClick={() => void openPrevious()} disabled={busy}
                title="Swap a previously archived session back in" style={itemStyle(t, t.dim)}>
                <Icon name="ph-clock-counter-clockwise" size={13} color={t.dim} />
                Previous sessions…
              </button>
            ) : previous.length === 0 ? (
              <span style={{ padding: '7px 9px', fontSize: 11.5, color: t.dim }}>No previous sessions.</span>
            ) : (
              previous.map((p) => (
                <button key={p.id} type="button" onClick={() => void run(() => resumeCoordinatorSession(sessionId, terminalId, p.id))}
                  disabled={busy} title="Resume this session (the current one is archived, not lost)"
                  style={itemStyle(t, t.dim)}>
                  <Icon name="ph-clock-counter-clockwise" size={13} color={t.dim} />
                  {`Archived ${p.archivedAt ? new Date(p.archivedAt).toLocaleString() : 'earlier'}`}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
