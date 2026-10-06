/**
 * The owner-decisions block (decision cards spec 2026-10-06, Unit 3). A planning or research agent
 * ends its report with a fenced block of JSON entries, one per decision for the owner:
 *
 *   ```owner-decisions
 *   [ { "id": "LR-6", "kind": "decide", "question": "…", "context": "…", "options": [{ "label", "effect" }],
 *       "recommendation": "…", "why": "…", "default": "…", "where": { "path": "…", "section": "…" } } ]
 *   ```
 *
 * The daemon reads it from the agent's full final message, turns each valid entry into a
 * `proposed` ledger item (LedgerService.captureAgentBlock), and adds lines to the Finished notice.
 * Pure: parsing and the notice lines only.
 */

export type BlockParse =
  | { kind: 'none' }
  | { kind: 'broken'; reason: string }
  | { kind: 'ok'; entries: unknown[] };

export interface CaptureResult {
  /** The `seq` of each new proposed item. */
  created: number[];
  /** Entries that failed a check: their id (or "#<position>") and the failed check. */
  skipped: { id: string; reason: string }[];
}

export type CaptureOutcome = { kind: 'none' } | { kind: 'broken'; reason: string } | ({ kind: 'captured' } & CaptureResult);

const OPEN_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*owner-decisions[ \t]*$/;

/** Find the LAST owner-decisions block in a message and read its JSON array. */
export function parseOwnerDecisionsBlock(text: string): BlockParse {
  const lines = text.split(/\r?\n/);
  let open = -1;
  let fence = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(OPEN_FENCE);
    if (m) { open = i; fence = m[1]; break; }
  }
  if (open === -1) return { kind: 'none' };
  const close = new RegExp(`^[ \\t]*${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
  let end = -1;
  for (let i = open + 1; i < lines.length; i++) {
    if (close.test(lines[i])) { end = i; break; }
  }
  if (end === -1) return { kind: 'broken', reason: 'the block has no closing fence' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines.slice(open + 1, end).join('\n'));
  } catch (err: any) {
    const detail = String(err?.message ?? err).trim().replace(/\.$/, '');
    return { kind: 'broken', reason: `it is not valid JSON (${detail})` };
  }
  if (!Array.isArray(parsed)) return { kind: 'broken', reason: 'it is not a JSON array' };
  return { kind: 'ok', entries: parsed };
}

/** "N30", "N30, N31", "N30 to N36" (a run of 3 or more), else a comma list. */
export function formatSeqList(seqs: readonly number[]): string {
  const run = seqs.length >= 3 && seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
  if (run) return `N${seqs[0]} to N${seqs[seqs.length - 1]}`;
  return seqs.map((s) => `N${s}`).join(', ');
}

/** The lines the Finished notice gains. Texts from the spec, word for word. */
export function formatOwnerDecisionsNotice(outcome: CaptureOutcome): string[] {
  if (outcome.kind === 'none') return [];
  if (outcome.kind === 'broken') return [`The owner-decisions block could not be read: ${outcome.reason}. Ask the agent to fix it.`];
  const lines: string[] = [];
  const n = outcome.created.length;
  if (n) {
    lines.push(
      `This report has ${n} owner decision${n === 1 ? '' : 's'} (${formatSeqList(outcome.created)}). ` +
      'Triage each now: ledger_add_from_agent sends it to the user; ledger_decide_self records your own choice.',
    );
  }
  for (const s of outcome.skipped) lines.push(`Skipped owner decision ${s.id}: ${s.reason}`);
  return lines;
}
