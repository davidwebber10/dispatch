// Pure logic behind <ThreadAskBanner>: given a thread's live status and its persisted row,
// decide whether it is waiting on the human with a DECLARED question — and, if so, the text to
// surface. Split out from the component so the decision (which is all the interesting behaviour)
// is unit-testable without rendering.
//
// Why this exists: a thread that ends its turn by calling report_status({ state:'needs_you',
// ask }) puts the question ONLY on the status channel — it stamps config.lastOutcome (the board
// card) and sets the live `activity`, but never writes the question into the thread transcript.
// So in thread mode (the conversation) the question is invisible unless the model ALSO said it
// in its reply. This surfaces that declared ask right in the thread as a safety net.
//
// INFERRED asks are deliberately excluded: the closing-sentence heuristic reads them FROM the
// transcript, so they are already visible there — a banner would just double the question. The
// server labels an inferred ask's live activity with a fixed generic string (see
// server.ts's markNeedsInput: detail.inferred ? 'Asked a question' : detail.ask), which is the
// signal we filter on for the live path; the persisted path filters on outcome.inferred.

import type { Terminal } from '../../api/types';
import type { ThreadStatus } from '../../stores/threadStatus';

/** The generic activity label the server writes for an INFERRED ask (server.ts markNeedsInput).
 *  A declared ask's activity is the real question, so this exact string is our "skip" marker. */
const GENERIC_INFERRED_ACTIVITY = 'Asked a question';

interface ParsedOutcome {
  summary: string;
  needsHelp: boolean;
  inferred: boolean;
}

/** Parse config.lastOutcome the same tolerant way the board does — absent/malformed is just
 *  "no declared outcome", never an error. Only the three fields the banner needs. */
function parseOutcome(tab: Pick<Terminal, 'config'> | undefined): ParsedOutcome | null {
  const raw = (tab?.config as Record<string, unknown> | undefined)?.lastOutcome;
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.summary !== 'string') return null;
  return { summary: o.summary, needsHelp: o.needsHelp === true, inferred: o.inferred === true };
}

type LiveStatus = Pick<ThreadStatus, 'status' | 'threadStatus' | 'activity'>;
type TabRow = Pick<Terminal, 'status' | 'config'>;

/**
 * The pending declared question to surface in thread mode, or null when there's nothing to show.
 *
 * Live status is authoritative when present (it's the freshest, and reflects THIS turn): if the
 * thread isn't `needs_input` live, show nothing — this is what stops a stale persisted row from
 * flashing the banner after the human has already answered. Only when no live status has arrived
 * yet (a fresh page load / reconnect, before any terminal:status event) do we fall back to the
 * persisted row + a declared needs-help outcome.
 */
export function pendingAsk(live: LiveStatus | undefined, tab: TabRow | undefined): string | null {
  if (live) {
    const needs = live.threadStatus === 'needs_input' || live.status === 'needs_input';
    if (!needs) return null;
    const ask = live.activity?.trim();
    // No ask text yet, or an inferred ask (labelled generically, already in the transcript).
    if (!ask || ask === GENERIC_INFERRED_ACTIVITY) return null;
    return ask;
  }
  // No live status — fall back to the persisted row. Requires BOTH that the row is waiting and
  // that its recorded outcome is a DECLARED ask (inferred outcomes live in the transcript).
  if (tab?.status !== 'needs_input') return null;
  const outcome = parseOutcome(tab);
  if (outcome?.needsHelp && !outcome.inferred) {
    const s = outcome.summary.trim();
    if (s) return s;
  }
  return null;
}
