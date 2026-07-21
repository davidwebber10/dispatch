import { useState } from 'react';
import { useTabs, findTerminal } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { api } from '../../api/client';

/**
 * CLI ⇄ Pretty transport switch for a running claude-code/codex thread. This is the ONLY
 * render switch (the frontend-only View/Terminal `ModeToggle` was removed): it changes the
 * thread's actual backend transport — killing the current process and re-spawning it RESUMING
 * its conversation in the other transport (`config.transport` structured ↔ absent).
 *
 * Disabled (with a tooltip) in two cases: until the thread has captured an `external_id`
 * (a brand-new thread has no session to resume yet), and WHILE A TURN IS IN FLIGHT — switching
 * mid-turn kills the process out from under a streaming/compacting response and strands it, so
 * you can only switch between turns. Renders nothing for non-AI tabs.
 */
export function TransportToggle({ terminalId, floating = false }: { terminalId: string | null | undefined; floating?: boolean }) {
  const tab = useTabs((s) => (terminalId ? findTerminal(s.byProject, terminalId) : undefined));
  const threadStatus = useThreadStatus((s) => (terminalId ? s.byTerminal[terminalId]?.threadStatus : undefined));
  const [busy, setBusy] = useState(false);

  if (!terminalId || !tab || (tab.type !== 'claude-code' && tab.type !== 'codex')) return null;

  const current: 'cli' | 'pretty' = (tab.config as { transport?: string } | undefined)?.transport === 'structured' ? 'pretty' : 'cli';
  // A turn is in flight when the CLI is starting or actively working (this also covers a native
  // compaction, which the StatusService reports as working) — the window where a resume-respawn
  // would drop live output.
  const midTurn = threadStatus === 'working' || threadStatus === 'starting';
  const canSwitch = !!tab.externalId && !midTurn;

  async function switchTo(target: 'cli' | 'pretty') {
    if (busy || !tab || target === current || !canSwitch) return;
    setBusy(true);
    try {
      await api.switchTransport(terminalId!, target === 'pretty' ? 'structured' : 'pty');
      await useTabs.getState().loadTabs(tab.sessionId);
    } catch {
      /* a 409 (busy / no session) leaves the thread as-is; the control just re-enables */
    } finally {
      setBusy(false);
    }
  }

  const dim = floating ? { w: 46, h: 32, radius: 9, pad: 3, font: 11 } : { w: 40, h: 24, radius: 6, pad: 2, font: 10.5 };
  const opts: ['cli' | 'pretty', string][] = [['cli', 'CLI'], ['pretty', 'Pretty']];
  const tip = !tab.externalId
    ? 'Send a message first to enable switching'
    : midTurn
      ? 'Wait for the current turn to finish'
      : undefined;

  return (
    <div
      role="group"
      aria-label="Transport"
      title={tip}
      style={{
        display: 'flex', gap: 2, padding: dim.pad,
        borderRadius: floating ? 11 : 8,
        background: floating ? 'rgba(22,22,26,0.55)' : 'var(--color-elevated)',
        border: floating ? '1px solid rgba(255,255,255,0.10)' : '1px solid #2C2C32',
        opacity: busy ? 0.6 : 1,
        ...(floating ? { backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', boxShadow: '0 6px 18px -8px rgba(0,0,0,.6)' } : {}),
      }}
    >
      {opts.map(([m, label]) => {
        const on = current === m;
        // The active segment is a non-actionable indicator; the OTHER is the switch action,
        // disabled until a session exists to resume into.
        const disabled = busy || (!on && !canSwitch);
        return (
          <button
            key={m}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            title={!on ? tip : undefined}
            onClick={() => void switchTo(m)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              minWidth: dim.w, height: dim.h, padding: '0 8px', borderRadius: dim.radius, border: 'none',
              font: `600 ${dim.font}px var(--font-mono, monospace)`, letterSpacing: '0.4px',
              cursor: disabled ? (on ? 'default' : 'not-allowed') : 'pointer',
              background: on ? (floating ? 'rgba(255,255,255,0.14)' : 'var(--color-hover)') : 'transparent',
              color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              transition: 'background .12s ease, color .12s ease',
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
