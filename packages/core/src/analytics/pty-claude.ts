import fs from 'fs';
import { usageFromFrame, toolCallsInFrame } from './frames.js';

export interface TailResult {
  input: number; output: number; cacheRead: number; cacheCreate: number;
  messages: number; toolCalls: number; model: string; nextOffset: number;
}

/**
 * Sum the usage in a Claude transcript from `fromOffset` to the end.
 *
 * A Claude transcript carries per-message usage and no running total, so a turn's
 * usage is the sum of the messages written since the previous read — which is why
 * this needs a byte cursor at all. The Codex reader does not, because it diffs a
 * total that means the same thing wherever it is found.
 *
 * A file SHORTER than the offset means something rewrote it (a compaction is the
 * suspected cause; nobody has verified Claude's transcript is strictly append-only
 * across one). Reading from a stale offset would return garbage, so start over.
 */
export function readClaudeTail(file: string, fromOffset: number): TailResult | null {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return null; }

  const start = fromOffset > size ? 0 : fromOffset;

  let raw: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      raw = buf.toString('utf-8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }

  const out: TailResult = {
    input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
    messages: 0, toolCalls: 0, model: '', nextOffset: size,
  };

  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    let ev: unknown;
    try { ev = JSON.parse(ln); } catch { continue; }
    out.toolCalls += toolCallsInFrame(ev);
    const usage = usageFromFrame(ev);
    if (!usage) continue;
    out.input += usage.input;
    out.output += usage.output;
    out.cacheRead += usage.cacheRead;
    out.cacheCreate += usage.cacheCreate;
    out.messages += 1;
    if (usage.model) out.model = usage.model;
  }

  return out;
}
