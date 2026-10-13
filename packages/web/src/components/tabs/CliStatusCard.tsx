import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useThreadStatus } from '../../stores/threadStatus';
import { StatusNotice } from './chat/StatusNotice';

/**
 * The latest DECLARED turn outcome (`config.lastOutcome`, stamped by report_status),
 * rendered under a CLI-transport AI thread's terminal, in its footer (2026-10-12: it sat
 * above the terminal; a Pretty thread shows it at the bottom). This is the CLI-view sibling of
 * the Pretty chat's inline StatusNotice: agents put their real findings in
 * report_status's arguments, and the TUI collapses tool arguments to one truncated
 * line — so a turn's substance was invisible in this view unless the agent also said
 * it in prose. The card surfaces it.
 *
 * Deliberately narrow, mirroring ThreadAskBanner's philosophy next door:
 * - Only DECLARED outcomes (needsHelp, or declaredState done/blocked). An inferred
 *   outcome's summary is just the reply's closing text, already on screen in the TUI.
 * - Never the `ask` — ThreadAskBanner owns the declared question; two banners asking
 *   the same thing would read as a nag.
 * - Dimmed and marked "Last turn" while a turn is in flight: the outcome describes the
 *   PREVIOUS turn. It keeps its place so the terminal does not resize (it used to hide).
 *   On settle it refetches the terminal row, so the fresh turn's outcome appears without
 *   a reload.
 */
export function CliStatusCard({ tab }: { tab: Terminal }) {
  const threadStatus = useThreadStatus((s) => s.byTerminal[tab.id]?.threadStatus);
  const [outcome, setOutcome] = useState<unknown>((tab.config as Record<string, unknown> | undefined)?.lastOutcome);
  const working = threadStatus === 'working' || threadStatus === 'starting';
  const prevWorking = useRef(working);

  useEffect(() => {
    const was = prevWorking.current;
    prevWorking.current = working;
    if (!was || working) return; // refetch only on the working → settled edge
    let on = true;
    void api.getTerminal(tab.id)
      .then((t) => { if (on) setOutcome((t.config as Record<string, unknown> | undefined)?.lastOutcome); })
      .catch(() => { /* keep the previous outcome; a fetch blip is not a state change */ });
    return () => { on = false; };
  }, [working, tab.id]);

  const input = noticeInput(outcome);
  if (!input) return null;
  // While a turn runs, the card keeps its place, dimmed and marked as the last turn (2026-10-12):
  // hiding it resized the terminal on every submit, and Codex's inline TUI reprints its history
  // on every resize. The new outcome replaces it when the turn settles.
  return (
    <div
      data-testid="cli-status-card"
      data-last-turn={working ? 'true' : undefined}
      title={working ? 'Last turn' : undefined}
      style={{ padding: '6px 12px 8px', flexShrink: 0, opacity: working ? 0.55 : undefined }}
    >
      <StatusNotice input={input} />
    </div>
  );
}

/** Map a persisted lastOutcome to StatusNotice's report_status-shaped input, or null
 *  when there is nothing declared to show. */
function noticeInput(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== 'object') return null;
  const o = outcome as Record<string, unknown>;
  if (typeof o.summary !== 'string' || !o.summary.trim()) return null;
  if (o.inferred === true) return null;
  const state = o.needsHelp === true ? 'needs_you'
    : o.declaredState === 'blocked' ? 'blocked'
    : o.declaredState === 'done' ? 'done'
    : null;
  if (!state) return null;
  return JSON.stringify({
    state,
    summary: o.summary,
    ...(state === 'blocked' && typeof o.blocker === 'string' ? { blocker: o.blocker } : {}),
  });
}
