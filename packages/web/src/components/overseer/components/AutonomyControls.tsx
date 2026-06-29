// Overseer — per-agent autonomy dial + graceful interrupt (shared controls).
//
// Mounted in the worker lightbox header (the monitor/interject surface). The dial
// is a compact Supervised ⇄ Autonomous segmented toggle:
//   - Supervised  → gated tools surface as Needs (the membrane; current behavior).
//   - Autonomous  → auto-allow, run free (resolves any pending request server-side).
// Interrupt sends the graceful structured `interrupt` control — it stops the current
// turn WITHOUT killing the thread, so it can be steered/resumed afterwards.
//
// Themeable via `scheme`: 'scoped' (overseer-root --tp/--ts/… vars) or 'global'
// (the --color-* tokens) so it renders correctly in either lightbox variant.

import { useEffect, useState } from 'react';
import { api } from '../../../api/client';
import { Icon } from '../atoms';

type Mode = 'supervised' | 'autonomous';
type Scheme = 'scoped' | 'global';

interface Tokens { border: string; dim: string; accent: string; accentFg: string; surface: string; danger: string; }

const SCHEMES: Record<Scheme, Tokens> = {
  scoped: { border: 'var(--border)', dim: 'var(--ts)', accent: 'var(--acc)', accentFg: '#06140B', surface: 'var(--elev)', danger: 'var(--red)' },
  global: { border: 'var(--color-border)', dim: 'var(--color-text-secondary)', accent: 'var(--color-accent)', accentFg: '#06140B', surface: 'var(--color-elevated)', danger: 'var(--color-status-red)' },
};

function modeOf(autonomy: unknown): Mode {
  return autonomy === 'autonomous' ? 'autonomous' : 'supervised';
}

/** Compact Supervised ⇄ Autonomous segmented toggle. Optimistic; reverts on error. */
export function AutonomyToggle({ terminalId, autonomy, scheme = 'scoped' }: { terminalId: string; autonomy?: unknown; scheme?: Scheme }) {
  const t = SCHEMES[scheme];
  const [mode, setMode] = useState<Mode>(modeOf(autonomy));
  const [busy, setBusy] = useState(false);

  // Re-sync if the underlying terminal config changes (e.g. store refresh / tabs event).
  useEffect(() => { setMode(modeOf(autonomy)); }, [autonomy]);

  const choose = async (next: Mode) => {
    if (busy || next === mode) return;
    const prev = mode;
    setMode(next); // optimistic
    setBusy(true);
    try { await api.setAutonomy(terminalId, next); }
    catch { setMode(prev); }
    finally { setBusy(false); }
  };

  const seg = (m: Mode, icon: string, label: string, title: string) => {
    const on = mode === m;
    return (
      <button
        type="button"
        onClick={() => choose(m)}
        disabled={busy}
        title={title}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '4px 9px',
          border: 'none',
          borderRadius: 6,
          background: on ? t.accent : 'transparent',
          color: on ? t.accentFg : t.dim,
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1,
          cursor: busy ? 'default' : 'pointer',
          fontFamily: 'inherit',
          opacity: busy ? 0.75 : 1,
        }}
      >
        <Icon name={icon} size={12} color={on ? t.accentFg : t.dim} weight={on ? 'fill' : 'regular'} />
        {label}
      </button>
    );
  };

  return (
    <div
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 8,
        background: t.surface,
        border: `1px solid ${t.border}`,
      }}
    >
      {seg('supervised', 'ph-shield-check', 'Supervised', 'Supervised — gated tools surface as Needs')}
      {seg('autonomous', 'ph-lightning', 'Auto', 'Autonomous — auto-allow, runs free')}
    </div>
  );
}

/** Graceful interrupt: stop the current turn WITHOUT killing the thread. */
export function InterruptButton({ terminalId, scheme = 'scoped' }: { terminalId: string; scheme?: Scheme }) {
  const t = SCHEMES[scheme];
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try { await api.interrupt(terminalId); }
    catch { /* best-effort — nothing to interrupt */ }
    finally { setBusy(false); }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title="Interrupt — stop the current turn (the thread stays alive)"
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 26,
        padding: '0 9px',
        borderRadius: 7,
        background: 'transparent',
        border: `1px solid ${t.border}`,
        color: t.danger,
        fontSize: 11,
        fontWeight: 500,
        lineHeight: 1,
        cursor: busy ? 'default' : 'pointer',
        fontFamily: 'inherit',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Icon name="ph-hand-palm" size={13} color={t.danger} />
      Interrupt
    </button>
  );
}

const actionBtn = (t: Tokens, color: string, busy: boolean): React.CSSProperties => ({
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 26,
  padding: '0 9px',
  borderRadius: 7,
  background: 'transparent',
  border: `1px solid ${t.border}`,
  color,
  fontSize: 11,
  fontWeight: 500,
  lineHeight: 1,
  cursor: busy ? 'default' : 'pointer',
  fontFamily: 'inherit',
  opacity: busy ? 0.6 : 1,
});

/** Stop — kill this agent's process. It stays in the rail (and the coordinator is told). */
export function StopButton({ terminalId, scheme = 'scoped' }: { terminalId: string; scheme?: Scheme }) {
  const t = SCHEMES[scheme];
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try { await api.stopTerminal(terminalId); }
    catch { /* best-effort */ }
    finally { setBusy(false); }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title="Stop — end this agent's process (it stays in the rail)"
      style={actionBtn(t, t.danger, busy)}
    >
      <Icon name="ph-stop" size={13} color={t.danger} />
      Stop
    </button>
  );
}

/** Archive — remove this agent from the rail entirely. Fires `onArchived` on success. */
export function ArchiveButton({ terminalId, scheme = 'scoped', onArchived }: { terminalId: string; scheme?: Scheme; onArchived?: () => void }) {
  const t = SCHEMES[scheme];
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try { await api.archiveTerminal(terminalId); onArchived?.(); }
    catch { /* best-effort */ }
    finally { setBusy(false); }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title="Archive — remove this agent from the rail"
      style={actionBtn(t, t.dim, busy)}
    >
      <Icon name="ph-archive" size={13} color={t.dim} />
      Archive
    </button>
  );
}
