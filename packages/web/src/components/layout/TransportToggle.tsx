import { HEADER_BOX, HEADER_INNER, HEADER_PAD } from './headerButton';
import { useState } from 'react';
import { useTabs, findTerminal } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { ConfirmModal } from '../common/ConfirmModal';

/**
 * CLI ⇄ Pretty transport switch for a running claude-code/codex thread. This is the ONLY
 * render switch (the frontend-only View/Terminal `ModeToggle` was removed): it changes the
 * thread's actual backend transport — killing the current process and re-spawning it RESUMING
 * its conversation in the other transport (`config.transport` structured ↔ absent).
 *
 * Disabled (dimmed, with a tooltip) in two cases: until the thread has captured an `external_id`
 * (a brand-new thread has no session to resume yet), and WHILE A TURN IS IN FLIGHT — switching
 * mid-turn kills the process out from under a streaming/compacting response and strands it, so
 * you can only switch between turns. The whole control greys out when it can't switch, so its
 * unavailability reads at a glance rather than only on hover. Renders nothing for non-AI tabs.
 */
/**
 * The CLI ⇄ Pretty switch for one thread, shared by this control, the phone's thread menu and the
 * Pretty hint (2026-11-06). `applies` is false for a thread with no second mode. A thread that is
 * working can still switch: `request` asks first ("Stop this turn and restart in Pretty?") and then
 * switches with force; render `confirmUi` wherever `request` is used.
 */
export function useTransportSwitch(terminalId: string | null | undefined, given?: Terminal) {
  // The store's row when it has one (it updates live), else the row the caller holds.
  const stored = useTabs((s) => (terminalId ? findTerminal(s.byProject, terminalId) : undefined));
  const tab = stored ?? given;
  const threadStatus = useThreadStatus((s) => (terminalId ? s.byTerminal[terminalId]?.threadStatus : undefined));
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<'cli' | 'pretty' | null>(null);
  const applies = !!terminalId && !!tab && (tab.type === 'claude-code' || tab.type === 'codex');
  const current: 'cli' | 'pretty' = (tab?.config as { transport?: string } | undefined)?.transport === 'structured' ? 'pretty' : 'cli';
  // A turn is in flight when the CLI is starting or actively working (this also covers a native
  // compaction, which the StatusService reports as working).
  const midTurn = threadStatus === 'working' || threadStatus === 'starting';
  const canSwitch = applies && !!tab?.externalId && !busy;
  const tip = !tab?.externalId ? 'Send a message first to enable switching' : undefined;
  async function switchTo(target: 'cli' | 'pretty', force = false) {
    if (busy || !tab || target === current || !canSwitch) return;
    setBusy(true);
    try {
      const transport = target === 'pretty' ? 'structured' : 'pty';
      await (force ? api.switchTransport(terminalId!, transport, { force: true }) : api.switchTransport(terminalId!, transport));
      await useTabs.getState().loadTabs(tab.sessionId);
    } catch {
      /* a 409 (no session) leaves the thread as-is; the control just re-enables */
    } finally {
      setBusy(false);
    }
  }
  /** Switch, asking first when the thread is mid-turn. */
  function request(target: 'cli' | 'pretty') {
    if (!canSwitch || target === current) return;
    if (midTurn) setAsking(target);
    else void switchTo(target);
  }
  const name = (m: 'cli' | 'pretty') => (m === 'pretty' ? 'Pretty' : 'CLI');
  const confirmUi = (
    <ConfirmModal
      open={!!asking}
      title={asking ? `Switch to ${name(asking)} now?` : ''}
      message={'This thread is working. Switching stops the current turn and restarts the thread in '
        + `${asking ? name(asking) : ''}, carrying on the same conversation. What it was in the middle of will not finish.`}
      confirmLabel="Stop and switch"
      onConfirm={() => { const t = asking; setAsking(null); if (t) void switchTo(t, true); }}
      onCancel={() => setAsking(null)}
    />
  );
  return { applies, tab, current, canSwitch, busy, tip, midTurn, switchTo, request, confirmUi };
}

export function TransportToggle({ terminalId, floating = false }: { terminalId: string | null | undefined; floating?: boolean }) {
  const { applies, tab, current, canSwitch, busy, request, confirmUi } = useTransportSwitch(terminalId);
  if (!applies || !tab) return null;

  const dim = floating ? { w: 46, h: 32, radius: 'var(--radius-md)', pad: 3, font: 11 } : { w: 40, h: HEADER_INNER, radius: 'var(--radius-sm)', pad: HEADER_PAD, font: 11 };
  const opts: ['cli' | 'pretty', string][] = [['cli', 'CLI'], ['pretty', 'Pretty']];
  const tip = !tab.externalId ? 'Send a message first to enable switching' : undefined;

  return (
    <>
    {confirmUi}
    <div
      role="group"
      aria-label="Transport"
      title={tip}
      style={{
        display: 'flex', gap: 2, padding: dim.pad,
        ...(floating ? { borderRadius: 'var(--radius-lg)', background: 'rgba(22,22,26,0.55)', border: '1px solid rgba(255,255,255,0.10)' } : HEADER_BOX),
        // Grey the whole control whenever switching is unavailable (no session yet, or a switch
        // in flight). Mid-turn it stays live and asks first (useTransportSwitch.request).
        opacity: busy || !canSwitch ? 0.45 : 1,
        transition: 'opacity .12s ease',
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
            onClick={() => request(m)}
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
    </>
  );
}
