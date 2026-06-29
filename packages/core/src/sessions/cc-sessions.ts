import fs from 'fs';
import os from 'os';
import path from 'path';

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
    out.push({ type: o.type, message: msg });
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/**
 * Synchronously read a claude session's transcript and return it as structured
 * backfill events (see backfillEventsFromTranscript). Resolves the standard
 * `~/.claude/projects/<enc-workDir>/<sessionId>.jsonl` path. Returns [] on any
 * error or when the file is missing / too large to read whole.
 */
export function readSessionBackfill(workDir: string, sessionId: string, limit = 2000): unknown[] {
  try {
    const encoded = workDir.replace(/\//g, '-');
    const file = path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
    const stat = fs.statSync(file);
    if (stat.size > MAX_BACKFILL_BYTES) return []; // too large — skip backfill
    const text = fs.readFileSync(file, 'utf-8');
    return backfillEventsFromTranscript(text, limit);
  } catch {
    return [];
  }
}

/**
 * List a project's recent Claude Code sessions (for the "resume" picker), newest
 * first. Reads `~/.claude/projects/<workDir-with-/replaced-by->/<uuid>.jsonl`.
 * Never throws — returns [] when the project dir doesn't exist.
 */
export async function listRecentSessions(workDir: string, limit = 20): Promise<RecentCcSession[]> {
  const encoded = workDir.replace(/\//g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded);

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
