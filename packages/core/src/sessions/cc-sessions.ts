import fs from 'fs';
import os from 'os';
import path from 'path';
import { isInjectedUserEntry } from '../conversation/task-notification.js';
import { resolveTranscriptPath, claudeProjectsRoot } from './transcript-path.js';
import { encodeClaudeProjectDir } from '../platform/encode.js';

export interface RecentCcSession {
  id: string;          // session UUID (jsonl filename)
  mtime: number;       // last-modified epoch ms
  preview: string;     // first user message (or summary), trimmed
  messageCount: number;
  truncated: boolean;  // count is a lower bound (file too big to scan fully)
}

const MAX_FULL = 3 * 1024 * 1024; // read whole file up to 3MB; beyond that, scan the head only
const HEAD_BYTES = 512 * 1024;

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text: string } => !!p && (p as any).type === 'text' && typeof (p as any).text === 'string')
      .map((p) => p.text)
      .join(' ');
  }
  return '';
}

async function readCapped(file: string, size: number): Promise<{ text: string; truncated: boolean }> {
  if (size <= MAX_FULL) return { text: await fs.promises.readFile(file, 'utf-8'), truncated: false };
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { text: buf.subarray(0, bytesRead).toString('utf-8'), truncated: true };
  } finally {
    await fh.close();
  }
}

/** Cap on a transcript file we'll read whole for backfill (skip beyond — documented limitation). */
const MAX_BACKFILL_BYTES = 16 * 1024 * 1024;

/**
 * Convert a Claude Code transcript JSONL into a compact list of structured
 * stream-json events (the same `{ type: 'user'|'assistant', message }` shapes the
 * live structured stream emits) so a resumed thread can replay its prior
 * conversation. Keeps user + assistant turns (including their tool_use / tool_result
 * content blocks, which the View already renders) and drops bookkeeping entries
 * (summaries, injected `isMeta` context, sub-agent `isSidechain` lines). Returns at
 * most `limit` entries, newest-trimmed. Never throws.
 *
 * Each entry's `uuid` (Claude Code's own per-line message id — present on both this
 * on-disk transcript AND the live CLI's stream-json stdout, verified against a real
 * captured session) is threaded through onto the emitted event when present, so a
 * client folding these backfilled events sees the SAME identity it would from a live
 * ws replay or a REST/transcript-parsed page (see conversation/transcript.ts, which
 * attaches the identical field). That shared identity is what lets the web client
 * dedup/anchor a REST page against an already-rendered ws tail by real message
 * identity instead of a lossy content fingerprint.
 */
export function backfillEventsFromTranscript(text: string, limit = 2000): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: any;
    try { o = JSON.parse(trimmed); } catch { continue; } // partial/garbled line
    if (!o || (o.type !== 'user' && o.type !== 'assistant')) continue;
    if (o.isMeta || o.isSidechain) continue;
    const msg = o.message;
    if (!msg || typeof msg !== 'object') continue;
    const content = msg.content;
    const hasContent =
      typeof content === 'string' ? content.trim().length > 0
      : Array.isArray(content) ? content.length > 0
      : false;
    if (!hasContent) continue;
    out.push(typeof o.uuid === 'string' ? { type: o.type, message: msg, uuid: o.uuid } : { type: o.type, message: msg });
  }
  const capped = out.length > limit ? out.slice(out.length - limit) : out;
  const tail = capped[capped.length - 1] as { type: string; message: unknown } | undefined;
  if (tail && tail.type === 'assistant' && !messageHasToolUse(tail.message)) {
    // Claude Code transcripts never write a trailing `result` line, so a revived thread's
    // ring buffer would otherwise end on `assistant` with nothing to clear the client's
    // `busy` flag. Synthesize one purely for that signal; the client recognizes
    // subtype:'backfill' and swallows it before it reaches the rendered timeline.
    capped.push({ type: 'result', subtype: 'backfill', is_error: false });
  }
  return capped;
}

/**
 * Synchronously read a claude session's transcript and return it as structured
 * backfill events (see backfillEventsFromTranscript). Resolves the standard
 * `~/.claude/projects/<enc-workDir>/<sessionId>.jsonl` path. Returns [] on any
 * error or when the file is missing / too large to read whole.
 */
export function readSessionBackfill(workDir: string, sessionId: string, limit = 2000): unknown[] {
  try {
    const file = resolveTranscriptPath(workDir, sessionId);
    if (!file) return [];
    const stat = fs.statSync(file);
    if (stat.size > MAX_BACKFILL_BYTES) return []; // too large — skip backfill
    const text = fs.readFileSync(file, 'utf-8');
    return backfillEventsFromTranscript(text, limit);
  } catch {
    return [];
  }
}

/**
 * The newest 'user' transcript-line uuid carrying REAL text content (not a bare
 * tool_result, which is also written as a `type: 'user'` line) that ISN'T already in
 * `excludeUuids`. Used right after a turn's `result` fires (see structured/manager.ts's
 * 'message-source' emit + sessions/service.ts's listener) to identify the uuid Claude Code
 * just assigned to the human/coordinator turn that started it — the CLI never echoes that
 * uuid back over stdout, so a fresh disk read is the only way to learn it. Scans the WHOLE
 * transcript (cheap: this runs against the same files backfill already reads whole) and
 * keeps the LAST match, since `excludeUuids` only screens out turns already resolved.
 * Returns undefined on any error (missing file, no match) — resolution is best-effort.
 */
export function findNewestUnresolvedUserUuid(workDir: string, sessionId: string, excludeUuids: Set<string>): string | undefined {
  try {
    const file = resolveTranscriptPath(workDir, sessionId);
    if (!file) return undefined;
    const text = fs.readFileSync(file, 'utf-8');
    let found: string | undefined;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let o: any;
      try { o = JSON.parse(trimmed); } catch { continue; } // partial/garbled line
      if (!o || o.type !== 'user' || o.isMeta || o.isSidechain || typeof o.uuid !== 'string') continue;
      if (excludeUuids.has(o.uuid)) continue;
      // A background-task completion OR a slash-command echo (/compact etc.) is written as a
      // `user` line WITH real text and no isMeta flag (see conversation/task-notification.ts).
      // If one lands after the turn being resolved, it would be picked as "the newest human
      // turn" and the source tag would attach to its uuid instead of the real message.
      if (isInjectedUserEntry(o)) continue;
      const content = o.message?.content;
      const hasRealText = typeof content === 'string' ? content.trim().length > 0
        : Array.isArray(content) ? content.some((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0)
        : false;
      if (hasRealText) found = o.uuid; // keep scanning — we want the newest match
    }
    return found;
  } catch {
    return undefined;
  }
}

/**
 * Merge durably-stored `source` tags (keyed by transcript uuid — see db/message-source.ts)
 * back onto backfilled events. backfillEventsFromTranscript's output never carries `meta`
 * (the on-disk transcript has no such field — only the live in-memory echo did, gone once
 * the CLI process exits), so a revived/re-hydrated thread loses the "via Dispatch" badge
 * unless this runs. Pure — the caller resolves `sourceByUuid` from SQLite. Leaves events
 * with no matching uuid untouched (graceful degradation for untagged/legacy turns).
 */
export function applyDurableSources(events: unknown[], sourceByUuid: Map<string, string>): unknown[] {
  if (!sourceByUuid.size) return events;
  return events.map((e) => {
    const o = e as any;
    if (o?.type === 'user' && typeof o.uuid === 'string' && sourceByUuid.has(o.uuid)) {
      return { ...o, meta: { ...(o.meta ?? {}), source: sourceByUuid.get(o.uuid) } };
    }
    return e;
  });
}

export interface TranscriptTokenStats {
  /** The last non-synthetic model seen in the transcript (models can vary across a resumed session). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input + output + cache_read — matches the Claude CLI's own token display. */
  totalTokens: number;
  messageCount: number;
}

/**
 * Sum per-message `usage` fields across a Claude transcript JSONL's assistant lines.
 * Shared by the session-stats route (layers cost-pricing on top) and the agent
 * completion hook (persists `totalTokens` onto the terminal's config) so the summing
 * logic lives in one place.
 */
export function sumTranscriptTokens(raw: string): TranscriptTokenStats {
  let model = '';
  let messageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  // Claude Code writes one JSONL line per content block (thinking/text/tool_use) within a
  // single assistant message, repeating the identical whole-message `usage` on every line.
  // Dedup by message.id so a message split across N lines is only counted once.
  const seenMessageIds = new Set<string>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const msg = entry.message;
      if (!msg || typeof msg !== 'object') continue;
      if (msg.model && msg.model !== '<synthetic>') model = msg.model;
      if (msg.usage) {
        if (msg.id) {
          if (seenMessageIds.has(msg.id)) continue;
          seenMessageIds.add(msg.id);
        }
        const u = msg.usage;
        inputTokens += u.input_tokens || 0;
        outputTokens += u.output_tokens || 0;
        cacheReadTokens += u.cache_read_input_tokens || 0;
        cacheCreationTokens += u.cache_creation_input_tokens || 0;
        messageCount++;
      }
    } catch { /* partial/garbled line */ }
  }

  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens,
    messageCount,
  };
}

/**
 * Read a terminal's transcript by workDir + session id and sum its token usage (see
 * sumTranscriptTokens). Resolves the same `~/.claude/projects/<enc-workDir>/<id>.jsonl`
 * path as readSessionBackfill. Returns null when the file is missing/unreadable.
 */
export function readTerminalTokenUsage(workDir: string, sessionId: string): TranscriptTokenStats | null {
  try {
    const file = resolveTranscriptPath(workDir, sessionId);
    if (!file) return null;
    return sumTranscriptTokens(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export interface TranscriptTailStatus {
  /** The transcript file's last-modified epoch ms — a reliable "newer activity" clock. */
  mtimeMs: number;
  /**
   * The last user/assistant turn completed cleanly: an assistant message with no
   * dangling `tool_use` block. An interrupted turn instead ends on an assistant
   * message that still has a `tool_use`, or on a `user` `tool_result` the model
   * never answered — both report `false`.
   */
  completed: boolean;
}

/** Only the file's tail is needed to classify the last turn; avoid reading multi-MB transcripts whole. */
const TAIL_BYTES = 256 * 1024;

function messageHasToolUse(message: unknown): boolean {
  const content = (message as any)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b: any) => b && b.type === 'tool_use');
}

/**
 * Shared tail-read for transcriptTailStatus/transcriptTailScheduled: reads only the last
 * TAIL_BYTES (dropping the first, possibly-partial line) and returns the file's mtime plus
 * the last non-meta/non-sidechain user/assistant message. Returns null when the transcript
 * is missing/unreadable (e.g. a thread that never captured an external_id). Never throws.
 */
function readLastTurn(workDir: string, sessionId: string): { mtimeMs: number; last: any; lastUsage: any } | null {
  try {
    const file = resolveTranscriptPath(workDir, sessionId);
    if (!file) return null;
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines.shift(); // the first line is likely truncated mid-JSON
    let last: any = null;
    let lastUsage: any = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let o: any;
      try { o = JSON.parse(trimmed); } catch { continue; }
      if (!o || (o.type !== 'user' && o.type !== 'assistant')) continue;
      if (o.isMeta || o.isSidechain) continue;
      last = o;
      if (o.type === 'assistant' && o.message?.usage) lastUsage = o.message.usage;
    }
    return { mtimeMs: stat.mtimeMs, last, lastUsage };
  } catch {
    return null;
  }
}

/**
 * Classify the tail of a claude session's transcript for the boot kickstart's
 * idempotency: is the last turn complete, and when did the file last change?
 * Returns null when the transcript is missing/unreadable — the caller treats that as
 * "no evidence of a completed turn." Never throws.
 */
export function transcriptTailStatus(workDir: string, sessionId: string): TranscriptTailStatus | null {
  const r = readLastTurn(workDir, sessionId);
  if (!r) return null;
  const completed = !!r.last && r.last.type === 'assistant' && !messageHasToolUse(r.last.message);
  return { mtimeMs: r.mtimeMs, completed };
}

// Mirrors structured/manager.ts's WAKE_TOOLS — kept as an independent literal (not imported)
// since this module classifies transcripts on disk, a different boundary than the live SDK
// stream manager.ts parses; duplicating two tool names is cheaper than coupling the modules.
const WAKE_TOOLS = new Set(['ScheduleWakeup', 'CronCreate']);

function lastToolUseName(message: unknown): string | undefined {
  const content = (message as any)?.content;
  if (!Array.isArray(content)) return undefined;
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i];
    if (b && b.type === 'tool_use' && typeof b.name === 'string') return b.name;
  }
  return undefined;
}

/**
 * Boot-recovery sibling to transcriptTailStatus: was the transcript's last turn left
 * dangling on a wake-scheduler tool (ScheduleWakeup/CronCreate)? Those end the turn
 * deliberately — the CLI process exits waiting on an external timer — so a tail that looks
 * "interrupted" (transcriptTailStatus's `completed: false`, a dangling tool_use) is actually
 * a dormant-but-will-resume thread, not a genuinely stuck one. Callers should check this
 * BEFORE treating `!completed` as evidence the thread needs a kickstart. Returns false (not
 * null) on a missing/unreadable transcript — "no evidence of scheduling" is the safe default
 * for a boot-recovery caller that already treats that case as "not evidently completed."
 */
export function transcriptTailScheduled(workDir: string, sessionId: string): boolean {
  const r = readLastTurn(workDir, sessionId);
  if (!r || !r.last || r.last.type !== 'assistant') return false;
  const name = lastToolUseName(r.last.message);
  return !!name && WAKE_TOOLS.has(name);
}

/**
 * List a project's recent Claude Code sessions (for the "resume" picker), newest
 * first. Reads `~/.claude/projects/<workDir-with-/replaced-by->/<uuid>.jsonl`.
 * Never throws — returns [] when the project dir doesn't exist.
 */
export async function listRecentSessions(workDir: string, limit = 20): Promise<RecentCcSession[]> {
  // Lists a whole project dir rather than one session, so there's no id to search by —
  // the corrected encoding is the whole fix here.
  const dir = path.join(claudeProjectsRoot(), encodeClaudeProjectDir(workDir, 'darwin'));

  let names: string[];
  try { names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl')); }
  catch { return []; }

  const stated = (await Promise.all(names.map(async (name) => {
    try { const s = await fs.promises.stat(path.join(dir, name)); return { name, mtime: s.mtimeMs, size: s.size }; }
    catch { return null; }
  }))).filter((x): x is { name: string; mtime: number; size: number } => !!x);

  stated.sort((a, b) => b.mtime - a.mtime);
  const top = stated.slice(0, limit);

  const out: RecentCcSession[] = [];
  for (const f of top) {
    try {
      const { text, truncated } = await readCapped(path.join(dir, f.name), f.size);
      const lines = text.split('\n');
      let preview = '';
      let summary = '';
      let messageCount = 0;
      for (const ln of lines) {
        if (!ln.trim()) continue;
        let o: any;
        try { o = JSON.parse(ln); } catch { continue; } // partial trailing line when truncated
        if (o?.type === 'summary' && typeof o.summary === 'string' && !summary) summary = o.summary;
        const msg = o?.message;
        if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
        if (o.isMeta) continue;
        messageCount++;
        if (!preview && msg.role === 'user') {
          const t = extractText(msg.content).replace(/\s+/g, ' ').trim();
          if (t && !t.startsWith('<')) preview = t.slice(0, 120);
        }
      }
      out.push({
        id: f.name.replace(/\.jsonl$/, ''),
        mtime: f.mtime,
        preview: (summary || preview || 'New session').slice(0, 120),
        messageCount,
        truncated,
      });
    } catch { /* skip unreadable file */ }
  }
  return out;
}

export interface ResumeAdvice {
  /** Minutes since the transcript's last user/assistant turn. */
  ageMinutes: number;
  /** Context size as of the last assistant turn (input + cache_read + cache_creation). */
  contextTokens: number;
  /** The session is old AND large enough that resuming it whole is worth warning about. */
  shouldPrompt: boolean;
}

// Claude Code's own defaults for its interactive resume dialog, read from the SAME env
// vars so a user who has tuned them gets one consistent answer in Pretty and the CLI.
const RESUME_AGE_MINUTES = 70;
const RESUME_TOKEN_THRESHOLD = 100_000;

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Should we offer to summarize before resuming this session?
 *
 * Claude Code asks the same question interactively ("This session is 3d 4h old and 134k
 * tokens…"), but that dialog is an Ink component the interactive shell renders — a Pretty
 * thread spawns with `-p` and never sees it, so it would silently resume full context and
 * burn the user's limits. This reproduces the CLI's gate off the transcript on disk.
 *
 * Context size is the LAST assistant turn's usage, not a sum across turns: cumulative
 * usage counts every cache read again on every turn and would wildly overstate what
 * actually sits in the window. Same formula the live ContextIndicator uses.
 *
 * Returns null when the transcript is missing/unreadable (e.g. a thread that never
 * captured an external_id) — the caller treats that as "nothing to advise". Never throws.
 */
export function resumeAdvice(workDir: string, sessionId: string, now = Date.now()): ResumeAdvice | null {
  const r = readLastTurn(workDir, sessionId);
  if (!r || !r.last) return null;
  // Prefer the message's own timestamp; fall back to file mtime when it's absent/unparseable.
  const stamped = Date.parse(r.last.timestamp ?? '');
  const lastActivity = Number.isFinite(stamped) ? stamped : r.mtimeMs;
  const ageMinutes = Math.max(0, (now - lastActivity) / 60000);
  const u = r.lastUsage;
  const contextTokens = u
    ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    : 0;
  const shouldPrompt =
    ageMinutes >= envNumber('CLAUDE_CODE_RESUME_THRESHOLD_MINUTES', RESUME_AGE_MINUTES) &&
    contextTokens >= envNumber('CLAUDE_CODE_RESUME_TOKEN_THRESHOLD', RESUME_TOKEN_THRESHOLD);
  return { ageMinutes, contextTokens, shouldPrompt };
}
