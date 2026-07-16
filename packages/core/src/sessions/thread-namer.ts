import fs from 'fs';
import os from 'os';
import path from 'path';
import { platform } from '../platform/index.js';

const MAX_NAME_LEN = 48;

/**
 * Collapse a raw candidate name to a single-line, whitespace-normalized string of
 * at most MAX_NAME_LEN chars, cutting on a word boundary (never mid-word) unless the
 * very first word alone exceeds the limit, in which case it's hard-cut. Returns null
 * when nothing survives collapsing/trimming.
 */
export function cleanName(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  if (collapsed.length <= MAX_NAME_LEN) return collapsed;
  const truncated = collapsed.slice(0, MAX_NAME_LEN);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace === -1 ? truncated : truncated.slice(0, lastSpace);
}

// Replicates cc-sessions.ts's (unexported) extractText — see
// packages/core/src/sessions/cc-sessions.ts:16-25. Claude Code message content is
// either a plain string or an array of content blocks; only `{type:'text', text}`
// blocks contribute (tool_use/tool_result/thinking blocks are dropped).
function extractClaudeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text: string } => !!p && (p as any).type === 'text' && typeof (p as any).text === 'string')
      .map((p) => p.text)
      .join(' ');
  }
  return '';
}

// Replicates codex-sessions.ts's (unexported) extractText — see
// packages/core/src/sessions/codex-sessions.ts:16-26. Codex response_item content
// blocks are tagged input_text/text/output_text (never Claude's bare 'text' alone).
function extractCodexText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text: string } =>
        !!p && typeof (p as any).text === 'string' && ['input_text', 'text', 'output_text'].includes((p as any).type))
      .map((p) => p.text)
      .join(' ');
  }
  return '';
}

/**
 * Claude Code branch: mirrors cc-sessions.ts:369-389's filtering exactly — a
 * `{type:'summary'}` line's summary wins over any prompt text if one appears anywhere
 * in the transcript; otherwise the first non-meta `message.role === 'user'` entry
 * whose extracted text doesn't start with '<' (Dispatch's injected system-hint /
 * local-command-caveat wrapper texts). Scans the WHOLE transcript (not just until the
 * first hit) because a summary line can appear after the opening prompt line.
 */
function deriveClaudeRaw(text: string): string {
  let summary = '';
  let preview = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: any;
    try { o = JSON.parse(trimmed); } catch { continue; } // partial/garbled line
    if (!summary && o?.type === 'summary' && typeof o.summary === 'string') summary = o.summary;
    const msg = o?.message;
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    if (o.isMeta) continue;
    if (!preview && msg.role === 'user') {
      const t = extractClaudeText(msg.content).replace(/\s+/g, ' ').trim();
      if (t && !t.startsWith('<')) preview = t;
    }
  }
  return summary || preview;
}

/**
 * Codex branch: mirrors codex-sessions.ts's real rollout line shape —
 * `{type:'response_item', payload:{type:'message', role, content}}` — and takes the
 * first `role: 'user'` message whose extracted text doesn't start with '<'.
 * `session_meta` and non-message response_item lines are skipped.
 */
function deriveCodexRaw(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: any;
    try { o = JSON.parse(trimmed); } catch { continue; } // partial/garbled line
    if (o?.type !== 'response_item' || o.payload?.type !== 'message') continue;
    if (o.payload.role !== 'user') continue;
    const t = extractCodexText(o.payload.content).replace(/\s+/g, ' ').trim();
    if (t && !t.startsWith('<')) return t;
  }
  return '';
}

/**
 * Derive a thread name candidate from a raw transcript. Pure (no fs) — callers read
 * the transcript first via resolveTranscriptPath + fs. Returns null on an empty/
 * unparseable transcript or when cleanName rejects the result.
 */
export function deriveThreadName(transcriptText: string, kind: 'claude' | 'codex'): string | null {
  if (!transcriptText) return null;
  const raw = kind === 'claude' ? deriveClaudeRaw(transcriptText) : deriveCodexRaw(transcriptText);
  return cleanName(raw);
}

const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

/**
 * Codex rollout files live at <root>/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl (see
 * codex-sessions.ts's listRecentCodexSessions doc comment) — the date/timestamp
 * segments aren't derivable from a session id alone, so finding a known id's
 * transcript means scanning the tree for a filename ending in `-<id>.jsonl`. Sync
 * (resolveTranscriptPath is synchronous) and directory-scoped — no file content is
 * read, only names, since the caller just needs a path. Returns null when the root
 * is missing or no rollout matches.
 */
function findCodexRolloutPath(sessionId: string, root: string): string | null {
  let entries: string[];
  try { entries = fs.readdirSync(root, { recursive: true }) as string[]; }
  catch { return null; }
  const suffix = `-${sessionId}.jsonl`;
  const match = entries.find((rel) => {
    const b = path.basename(rel);
    return b.startsWith('rollout-') && b.endsWith(suffix);
  });
  return match ? path.join(root, match) : null;
}

/**
 * Resolve a thread's transcript file path on disk. claude-code: deterministic join of
 * the platform's claudeProjectDir + `<externalId>.jsonl` (no fs touch — just string
 * construction, existence is the caller's problem). codex: scans `~/.codex/sessions`
 * (override via `codexSessionsRoot`, e.g. in tests) for the rollout file matching
 * externalId, since codex's on-disk layout embeds a timestamp we don't have. Returns
 * null without an externalId, for an unrecognized `type`, or when codex can't find a
 * match.
 */
export function resolveTranscriptPath(
  t: { type: string; externalId: string | null; workingDir: string | null },
  sessionWorkingDir: string,
  codexSessionsRoot: string = CODEX_SESSIONS_ROOT,
): string | null {
  if (!t.externalId) return null;
  if (t.type === 'claude-code') {
    return path.join(platform.claudeProjectDir(t.workingDir ?? sessionWorkingDir), `${t.externalId}.jsonl`);
  }
  if (t.type === 'codex') {
    return findCodexRolloutPath(t.externalId, codexSessionsRoot);
  }
  return null;
}
