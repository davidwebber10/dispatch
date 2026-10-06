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

/** The size limits of one block. A larger block is a broken block: no item changes. */
export const MAX_BLOCK_BYTES = 64 * 1024;
export const MAX_BLOCK_ENTRIES = 50;

/** A fence line (CommonMark): 0 to 3 spaces, 3 or more backticks or tildes, then the info string. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Find the LAST top-level owner-decisions block in a message and read its JSON array. The scan
 * runs from the top and tracks open fences as CommonMark does: a fence closes only with the same
 * character, at least as long, and nothing else on the line. So an owner-decisions fence inside
 * another fence (a quoted example, such as the spec's four-backtick `text` fence) is content, and
 * so is one indented 4 or more spaces (an indented code block). The size limits apply before the
 * JSON is read.
 */
export function parseOwnerDecisionsBlock(text: string): BlockParse {
  const lines = text.split(/\r?\n/);
  let last: { body: number; end: number } | null = null; // `end` -1: the fence never closes
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE_LINE);
    if (!m) continue;
    const [, fence, info] = m;
    if (fence[0] === '`' && info.includes('`')) continue; // not a fence: a backtick info string has no backtick
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (close.test(lines[j])) { end = j; break; }
    }
    if (info.trim() === 'owner-decisions') last = { body: i + 1, end };
    if (end === -1) break; // an unclosed fence runs to the end of the message
    i = end;
  }
  if (!last) return { kind: 'none' };
  if (last.end === -1) return { kind: 'broken', reason: 'the block has no closing fence' };
  const body = lines.slice(last.body, last.end).join('\n');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BLOCK_BYTES) {
    return { kind: 'broken', reason: `the block has ${bytes} bytes of text; the limit is ${MAX_BLOCK_BYTES} (64 KB)` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err: any) {
    const detail = String(err?.message ?? err).trim().replace(/\.$/, '');
    return { kind: 'broken', reason: `it is not valid JSON (${detail})` };
  }
  if (!Array.isArray(parsed)) return { kind: 'broken', reason: 'it is not a JSON array' };
  if (parsed.length > MAX_BLOCK_ENTRIES) {
    return { kind: 'broken', reason: `the block has ${parsed.length} entries; the limit is ${MAX_BLOCK_ENTRIES}` };
  }
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
