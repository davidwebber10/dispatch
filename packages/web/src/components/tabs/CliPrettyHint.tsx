import { useState } from 'react';
import { X } from '@phosphor-icons/react';
import type { Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';

/** One dismissal covers every thread — the hint is a one-time education, not a nag. */
export const CLI_PRETTY_HINT_KEY = 'dispatch:cliPrettyHint:dismissed';

/**
 * One-line nudge above a CLI-transport AI thread: long responses read best on the
 * Pretty (structured) transport. The CLI view can only show what survives the pty's
 * bounded byte replay — a width change rewraps it into noise, and a respawn reduces
 * history to the TUI's resume stub — so a finished turn's prose is routinely
 * unreadable there. The button performs the same switch as TransportToggle and is
 * gated the same way (a captured session id, no turn in flight).
 */
export function CliPrettyHint({ tab }: { tab: Terminal }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(CLI_PRETTY_HINT_KEY) === '1');
  const [busy, setBusy] = useState(false);
  const threadStatus = useThreadStatus((s) => s.byTerminal[tab.id]?.threadStatus);

  if (dismissed) return null;

  const midTurn = threadStatus === 'working' || threadStatus === 'starting';
  const canSwitch = !!tab.externalId && !midTurn && !busy;
  const tip = !tab.externalId
    ? 'Send a message first to enable switching'
    : midTurn
      ? 'Wait for the current turn to finish'
      : undefined;

  async function switchToPretty() {
    if (!canSwitch) return;
    setBusy(true);
    try {
      await api.switchTransport(tab.id, 'structured');
      await useTabs.getState().loadTabs(tab.sessionId);
    } catch {
      /* a 409 (busy / no session) leaves the thread as-is */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '5px 12px', flexShrink: 0,
        background: 'var(--color-elevated)', borderBottom: '1px solid #2C2C32',
        color: 'var(--color-text-secondary)', fontSize: 12, lineHeight: 1.4,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        Long responses read best in Pretty — the CLI view can rewrap or drop replayed output.
      </span>
      <button
        type="button"
        disabled={!canSwitch}
        title={tip}
        onClick={() => void switchToPretty()}
        style={{
          flexShrink: 0, height: 22, padding: '0 10px', borderRadius: 6, border: '1px solid #2C2C32',
          background: 'var(--color-hover)', color: 'var(--color-text-primary)',
          font: '600 11px var(--font-mono, monospace)', letterSpacing: '0.3px',
          cursor: canSwitch ? 'pointer' : 'not-allowed', opacity: canSwitch ? 1 : 0.5,
        }}
      >
        Switch to Pretty
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        title="Don't show this again"
        onClick={() => { localStorage.setItem(CLI_PRETTY_HINT_KEY, '1'); setDismissed(true); }}
        style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 20, height: 20, padding: 0, borderRadius: 5, border: 'none',
          background: 'transparent', color: 'var(--color-text-tertiary)', cursor: 'pointer',
        }}
      >
        <X size={12} weight="bold" />
      </button>
    </div>
  );
}
