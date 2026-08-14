import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { TerminalRow } from '../db/terminals.js';
import * as usageDb from '../db/usage.js';
import { usageFromFrame, toolCallsInFrame } from './frames.js';
import { resolveTranscriptPath } from '../sessions/transcript-path.js';
import { locateCodexTranscript } from './codex-locate.js';
import type { AgentType } from '../providers/agent-types.js';

export interface ImportThread {
  terminalId: string;
  projectId: string;
  provider: string;
  role: string;
  transcriptPath: string;
}

export interface LineResult { imported: number; skipped: number }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Claude's shape: every assistant message carries its OWN usage block, so one
 * line maps to (at most) one row with no state carried between lines.
 */
function importClaudeLines(db: Database.Database, t: ImportThread, raw: string, cutoff: string): LineResult {
  let imported = 0;
  let skipped = 0;

  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(ln); } catch { continue; }

    const usage = usageFromFrame(ev);
    if (!usage) continue;

    const at = typeof ev.timestamp === 'string' ? ev.timestamp : null;
    if (!at) { skipped += 1; continue; }
    if (at >= cutoff) { skipped += 1; continue; }

    usageDb.insertClosed(db, {
      id: randomUUID(),
      terminalId: t.terminalId,
      projectId: t.projectId,
      provider: t.provider,
      model: usage.model,
      role: t.role,
      startedAt: at,
      endedAt: at,
      outcome: 'idle',
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheCreate: usage.cacheCreate,
      messages: 1,
      toolCalls: toolCallsInFrame(ev),
      backfilled: true,
    });
    imported += 1;
  }

  return { imported, skipped };
}

/**
 * Codex's shape: no per-message usage exists. `token_count` events carry a
 * RUNNING TOTAL that grows through the file, so a per-turn figure only exists
 * as the diff between one `token_count` and the previous one — the same
 * arithmetic pty-capture.ts's live path performs at a single point, walked
 * here across the whole transcript.
 *
 * Deliberately reads `total_token_usage` and never `last_token_usage`: the
 * latter looks like a ready-made per-turn delta and is not — it breaks the
 * delta invariant in 9 of 648 real transitions and overcounts a real file by
 * 0.96% (see codex-frames.ts). `total_token_usage` is monotonic non-decreasing
 * across those same 648 transitions and survives `/compact`.
 *
 * Each diff is attributed to the model named by the most recent PRECEDING
 * `turn_context` — never one model for the whole file — because a mid-session
 * `/model` switch is real and was observed in a live transcript.
 *
 * The baseline starts at zero, so the very first `token_count` in the file
 * produces a real row (the session's opening usage), exactly as if a
 * zero-total `token_count` had preceded it — UNLESS a `token_count` arrives
 * before any `turn_context` at all. That happens for a subagent fork
 * (verified against a real file: six `token_count` events, the first already
 * at 192,605 input tokens, before its first `turn_context` at line 63) — the
 * fork inherits its parent's running total, so a pre-`turn_context` total
 * describes the PARENT's usage, not this thread's. Those steps are skipped
 * rather than attributed to a sentinel model: the number is known to be
 * wrong, and labelling it 'unknown' would only hide that. The baseline still
 * advances past them, exactly like the other three skip reasons below, so
 * the inherited total cannot leak into the thread's first real diff either.
 */
function importCodexLines(db: Database.Database, t: ImportThread, raw: string, cutoff: string): LineResult {
  let imported = 0;
  let skipped = 0;
  let model = '';
  let sawTurnContext = false;
  let prevInput = 0;
  let prevCached = 0;
  let prevOutput = 0;

  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(ln); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;

    if (ev.type === 'turn_context' && typeof ev.payload?.model === 'string') {
      model = ev.payload.model;
      sawTurnContext = true;
      continue;
    }

    if (ev.type !== 'event_msg' || ev.payload?.type !== 'token_count') continue;
    const total = ev.payload?.info?.total_token_usage;
    if (!total || typeof total !== 'object') continue;

    const curInput = num(total.input_tokens);
    const curCached = num(total.cached_input_tokens);
    const curOutput = num(total.output_tokens);

    const dInput = curInput - prevInput;
    const dCached = curCached - prevCached;
    const dOutput = curOutput - prevOutput;

    // The baseline always advances to what was actually observed, whether or
    // not this step produces a row — otherwise a skipped step's tokens would
    // bleed into the diff of whichever step comes next.
    prevInput = curInput;
    prevCached = curCached;
    prevOutput = curOutput;

    // A total_token_usage seen before this thread's first turn_context is a
    // parent's inherited figure on a subagent fork, not this thread's usage.
    // Skip it — the baseline above has already absorbed it, so it cannot
    // corrupt the diff once a turn_context finally arrives.
    if (!sawTurnContext) { skipped += 1; continue; }

    // Guard: a negative diff means the total moved backwards in a way nobody
    // has observed (total_token_usage is monotonic in every real file measured).
    // Never write a negative row — skip this step rather than guess.
    if (dInput < 0 || dCached < 0 || dOutput < 0) { skipped += 1; continue; }

    const at = typeof ev.timestamp === 'string' ? ev.timestamp : null;
    if (!at) { skipped += 1; continue; }
    if (at >= cutoff) { skipped += 1; continue; }

    usageDb.insertClosed(db, {
      id: randomUUID(),
      terminalId: t.terminalId,
      projectId: t.projectId,
      provider: t.provider,
      model,
      role: t.role,
      startedAt: at,
      endedAt: at,
      outcome: 'idle',
      input: Math.max(0, dInput - dCached),
      output: dOutput,
      cacheRead: dCached,
      cacheCreate: 0,
      messages: 1,
      toolCalls: 0,
      backfilled: true,
    });
    imported += 1;
  }

  return { imported, skipped };
}

/** One provider's behaviour for the manual history import: where its transcript lives, and how to turn one into rows. */
export interface HistoryImportStrategy {
  /** Locate this terminal's transcript for a manual history import, or undefined if none exists. */
  locateTranscript(terminal: TerminalRow, workingDir: string): string | undefined;
  /** Parse a WHOLE historical transcript into backfilled turn rows. */
  importLines(db: Database.Database, thread: ImportThread, raw: string, cutoff: string): LineResult;
}

/**
 * Every harness's history-import behaviour, declared in ONE place and shared by
 * routes/analytics.ts (which locates each terminal's transcript to build the
 * import list) and importer.ts (which parses it). Keyed off `AGENT_TYPES` via
 * `Record<AgentType, ...>`, so a fourth agent type with no entry here is a type
 * error at compile time, not a thread that silently imports zero rows the way an
 * unrouted Codex thread used to (routes/analytics.ts's own history, see the
 * comment at its former `if (terminal.type === 'codex')` branch).
 *
 * `null` is Grok's deliberate declaration: it has no transcript to import from at
 * all (see pty-capture.ts's PTY_CAPTURE_STRATEGY for the same fact on the live
 * side). A test (capture-drift.test.ts) asserts every AGENT_TYPES member has a
 * key here — present-but-null passes, absent does not.
 */
export const HISTORY_IMPORT_STRATEGY: Record<AgentType, HistoryImportStrategy | null> = {
  'claude-code': {
    // Mirrors the original guard exactly: resolveTranscriptPath is only ever
    // asked with a non-empty working dir — an unknown working dir means "no
    // transcript", not "search every project directory".
    locateTranscript: (terminal, workingDir) =>
      workingDir ? resolveTranscriptPath(workingDir, terminal.external_id || '') : undefined,
    importLines: importClaudeLines,
  },
  codex: {
    // Codex needs no working dir — locateCodexTranscript searches ~/.codex/sessions
    // (and its archive) by the thread's external_id alone.
    locateTranscript: (terminal) => locateCodexTranscript(terminal.external_id || ''),
    importLines: importCodexLines,
  },
  grok: null,
};
