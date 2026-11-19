import fs from 'node:fs';
import type { ConvItem } from '../conversation/transcript.js';
import type { TranscriptLocation } from '../conversation/reader.js';
import { TRANSCRIPT_OPEN_FLAGS, openedTranscriptTrusted } from '../conversation/transcript-trust.js';
import type { MessageJournal, JournalItem } from '../journal/journal.js';
import type { TurnInput } from '../db/memory.js';

/**
 * The new words of one thread, from where its cursor stopped (spec 2026-11-17-memory-design.md, slice 1.4).
 * Only the person's and the agent's text: no tool calls, no tool results, no thinking, no notices (the
 * harness's own context items are already left out by the parsers and the journal recorder).
 *
 *   A Claude Code or Codex thread (terminal or Pretty): its harness file (Claude JSONL, Codex rollout),
 *   by byte offset. The file is complete and is never trimmed by Dispatch.
 *   Any other harness: the message journal, by seq.
 */

/** At most this much of a file is read in one pass; the next pass goes on from there. */
export const FILE_CHUNK_BYTES = 4 * 1024 * 1024;

export interface FileIncrement { turns: TurnInput[]; source: string; offset: number; more: boolean }

const turnOf = (item: ConvItem, ref: string | null): TurnInput | null => {
  if ((item.kind !== 'user' && item.kind !== 'assistant') || !item.text?.trim()) return null;
  return { role: item.kind, text: item.text, ref: item.uuid ?? ref, at: item.ts ?? null };
};

/**
 * Read the complete lines of `loc.file` after `offset` (at most FILE_CHUNK_BYTES). A file other than the
 * cursor's `source`, or one shorter than the offset (replaced), is read from its start. Null when the
 * file cannot be opened as a trusted transcript.
 */
export async function readFileIncrement(loc: TranscriptLocation, source: string | null, offset: number): Promise<FileIncrement | null> {
  let fh: fs.promises.FileHandle;
  try { fh = await fs.promises.open(loc.file, TRANSCRIPT_OPEN_FLAGS); } catch { return null; }
  try {
    const st = await fh.stat();
    if (!openedTranscriptTrusted(st)) return null;
    let start = source === loc.file ? offset : 0;
    if (start > st.size) start = 0;
    const length = Math.min(st.size - start, FILE_CHUNK_BYTES);
    if (length <= 0) return { turns: [], source: loc.file, offset: start, more: false };
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    // Only whole lines: a line that the harness is still writing waits for the next pass.
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) return { turns: [], source: loc.file, offset: start, more: false };
    const text = buf.subarray(0, end + 1).toString('utf8');
    const turns: TurnInput[] = [];
    let at = start;
    for (const line of text.split('\n')) {
      const lineStart = at;
      at += Buffer.byteLength(line, 'utf8') + 1;
      if (!line.trim()) continue;
      for (const item of loc.parseLine(line)) {
        const t = turnOf(item, `@${lineStart}`);
        if (t) turns.push(t);
      }
    }
    const next = start + end + 1;
    return { turns, source: loc.file, offset: next, more: next < st.size };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

function journalText(item: JournalItem): string {
  const p = item.payload as { message?: { content?: unknown } } | null;
  const c = p?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

/** The journal rows after `afterSeq` (at most `limit`), as turns, with the seq to store. */
export function readJournalIncrement(journal: MessageJournal, terminalId: string, afterSeq: number, limit = 500): { turns: TurnInput[]; lastSeq: number; more: boolean } {
  const page = journal.page(terminalId, { afterSeq, limit });
  const turns: TurnInput[] = [];
  let lastSeq = afterSeq;
  for (const item of page.items) {
    lastSeq = Math.max(lastSeq, item.seq);
    if (item.kind !== 'user' && item.kind !== 'assistant') continue;
    const text = journalText(item);
    if (text.trim()) turns.push({ role: item.kind, text, ref: `#${item.seq}`, at: item.at });
  }
  return { turns, lastSeq, more: page.hasMore };
}
