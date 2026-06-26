import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RecentCodexSession {
  id: string;          // Codex session_id (uuid)
  mtime: number;       // last-modified epoch ms
  preview: string;     // first user message, trimmed
  messageCount: number;
  truncated: boolean;  // count is a lower bound (file larger than the scanned head)
}

const HEAD_BYTES = 128 * 1024;  // scan only the head — previews/meta are near the top
const SCAN_CAP = 300;           // bound work: sessions aren't organized by cwd

function extractText(content: unknown): string {
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

async function readHead(file: string, size: number): Promise<{ text: string; truncated: boolean }> {
  if (size <= HEAD_BYTES) return { text: await fs.promises.readFile(file, 'utf-8'), truncated: false };
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { text: buf.subarray(0, bytesRead).toString('utf-8'), truncated: true };
  } finally { await fh.close(); }
}

/**
 * List a project's recent Codex sessions (for the "resume" picker), newest first.
 * Codex writes rollout files at ~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl;
 * line 1 is { type:'session_meta', payload:{ session_id, cwd } }, followed by
 * { type:'response_item', payload:{ type:'message', role, content } } lines.
 * Sessions aren't organized by cwd, so we stat+sort every rollout by mtime and read
 * newest-first until `limit` match `workDir`. Never throws — returns [] on failure.
 */
export async function listRecentCodexSessions(
  workDir: string,
  limit = 20,
  root = path.join(os.homedir(), '.codex', 'sessions'),
): Promise<RecentCodexSession[]> {
  let entries: string[];
  try { entries = (await fs.promises.readdir(root, { recursive: true })) as string[]; }
  catch { return []; }
  const rollouts = entries.filter((p) => {
    const b = path.basename(p);
    return b.startsWith('rollout-') && b.endsWith('.jsonl');
  });

  const stated = (await Promise.all(rollouts.map(async (rel) => {
    const full = path.join(root, rel);
    try { const s = await fs.promises.stat(full); return { full, mtime: s.mtimeMs, size: s.size }; }
    catch { return null; }
  }))).filter((x): x is { full: string; mtime: number; size: number } => !!x);

  stated.sort((a, b) => b.mtime - a.mtime);

  const out: RecentCodexSession[] = [];
  for (const f of stated.slice(0, SCAN_CAP)) {
    if (out.length >= limit) break;
    try {
      const { text, truncated } = await readHead(f.full, f.size);
      const lines = text.split('\n');
      let sessionId = '';
      let cwd = '';
      let metaSeen = false;
      let preview = '';
      let messageCount = 0;
      for (const ln of lines) {
        if (!ln.trim()) continue;
        let o: any;
        try { o = JSON.parse(ln); } catch { continue; }  // partial trailing line when truncated
        if (!metaSeen && o?.type === 'session_meta') {
          sessionId = typeof o.payload?.session_id === 'string' ? o.payload.session_id : '';
          cwd = typeof o.payload?.cwd === 'string' ? o.payload.cwd : '';
          metaSeen = true;
          if (cwd !== workDir) break;  // wrong project — stop scanning this file
          continue;
        }
        if (metaSeen && o?.type === 'response_item' && o.payload?.type === 'message') {
          const role = o.payload.role;
          if (role !== 'user' && role !== 'assistant') continue;
          messageCount++;
          if (!preview && role === 'user') {
            const t = extractText(o.payload.content).replace(/\s+/g, ' ').trim();
            if (t && !t.startsWith('<')) preview = t;
          }
        }
      }
      if (!metaSeen || cwd !== workDir || !sessionId) continue;
      out.push({ id: sessionId, mtime: f.mtime, preview: (preview || 'New session').slice(0, 120), messageCount, truncated });
    } catch { /* skip unreadable file */ }
  }
  return out;
}
