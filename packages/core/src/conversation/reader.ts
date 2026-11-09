// packages/core/src/conversation/reader.ts
// Pages and searches a thread's transcript file without a full read and without a block of the
// event loop (W2-B). Before this, SessionService.getConversation did `fs.readFileSync` + `split`
// on the whole file for each request: a 100 MB transcript stopped the daemon for each page.
//
// The reader keeps a LineIndex for each file (line number -> byte offset), computes the line window
// with the same four rules as before, and reads only the bytes of that window. The answer for a
// given file and options is the same JSON text as the old code gave.
import fs from 'fs';
import { performance } from 'perf_hooks';
import type Database from 'better-sqlite3';
import * as messageSourceDb from '../db/message-source.js';
import { readTail } from '../sessions/tail-read.js';
import { LineIndex, readFully, yieldToLoop, type LineSnapshot } from './line-index.js';
import type { ConvItem } from './transcript.js';

export interface ConvPage {
  items: ConvItem[];
  /** The count of complete lines in the file: the bottom edge, for a poll with `since`. */
  cursor: number;
  /** The first line of the returned window. */
  startLine: number;
  /** True when older lines exist above the window. */
  hasMore: boolean;
  /** Set (to true) only for a thread type that has no transcript, such as a shell. */
  unsupported?: boolean;
}

export interface ConvPageOptions {
  since?: number;
  before?: number;
  beforeUuid?: string;
  limit?: number;
}

export interface SearchMatch { line: number; kind: string; snippet: string }

/** Where a thread's transcript is, and the parser for one line of its format. */
export interface TranscriptLocation {
  file: string;
  parseLine: (line: string) => ConvItem[];
}

export interface ConversationReaderDeps {
  db: Database.Database;
  /** `null`: the thread has no transcript yet. `'unsupported'`: its type never has one. */
  locate(terminalId: string): TranscriptLocation | null | 'unsupported';
}

/** Lines are read in groups of about this many bytes. A longer single line is one group. */
const GROUP_BYTES = 1024 * 1024;
/** `beforeUuid` scans backward from the tail in windows of about this many bytes. */
const UUID_WINDOW_BYTES = 256 * 1024;
/** Parse work runs for this long at most before the loop gets a turn. */
const SLICE_MS = 8;
/** First window of the synchronous tail read (tailItems). It doubles while it holds too few lines. */
const TAIL_FIRST_BYTES = 8 * 1024 * 1024;
const DEFAULT_LIMIT = 200;

/** The file changed under the reader (cut, or replaced). The caller drops the index and tries again. */
const CHANGED = Symbol('transcript changed');
type Changed = typeof CHANGED;

/** Gives the event loop a turn when the current slice of synchronous work is `SLICE_MS` old. */
class Slicer {
  private since = performance.now();
  due(): boolean { return performance.now() - this.since > SLICE_MS; }
  restart(): void { this.since = performance.now(); }
  async pause(): Promise<void> { await yieldToLoop(); this.restart(); }
}

const emptyPage = (): ConvPage => ({ items: [], cursor: 0, startLine: 0, hasMore: false });

export class ConversationReader {
  constructor(private readonly deps: ConversationReaderDeps) {}

  /**
   * One window of the transcript. The window rules, in order:
   *  - `beforeUuid` found in the file: the `limit` lines before that line;
   *  - `before` > 0: the `limit` lines before line `before`;
   *  - `since` > 0: every line from `since` to the end (a poll);
   *  - otherwise: the newest `limit` lines.
   */
  async page(terminalId: string, opts: ConvPageOptions = {}): Promise<ConvPage> {
    const located = this.deps.locate(terminalId);
    if (located === 'unsupported') return { ...emptyPage(), unsupported: true };
    if (!located) return emptyPage();
    // One more try when the file was cut or replaced during the read: the index is built again.
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await this.pageOnce(terminalId, located, opts);
      if (page !== CHANGED) return page;
      LineIndex.forget(located.file);
    }
    return emptyPage();
  }

  private async pageOnce(terminalId: string, located: TranscriptLocation, opts: ConvPageOptions): Promise<ConvPage | Changed> {
    let fh: fs.promises.FileHandle;
    let snap: LineSnapshot;
    try {
      snap = (await LineIndex.open(located.file)).snapshot();
      fh = await fs.promises.open(located.file, 'r');
    } catch {
      return emptyPage(); // no file, or not readable: the same answer as before
    }
    let items: ConvItem[] | Changed;
    let start: number;
    const total = snap.lineCount;
    try {
      if ((await fh.stat()).ino !== snap.ino) return CHANGED;
      const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;

      // The anchor is a recently rendered item, so it is near the end: scan backward from the tail.
      let beforeFromUuid: number | undefined;
      if (opts.beforeUuid) {
        const found = await findUuidLine(fh, snap, opts.beforeUuid);
        if (found === CHANGED) return CHANGED;
        beforeFromUuid = found;
      }

      let end: number;
      if (beforeFromUuid !== undefined) {                        // precise anchor (scroll up, first page)
        end = beforeFromUuid;
        start = Math.max(0, end - limit);
      } else if (opts.before !== undefined && opts.before > 0) { // older window (scroll up)
        end = Math.min(opts.before, total);
        start = Math.max(0, end - limit);
      } else if (opts.since !== undefined && opts.since > 0) {   // new lines (poll)
        start = Math.min(opts.since, total);
        end = total;
      } else {                                                   // initial: most recent `limit`
        end = total;
        start = Math.max(0, total - limit);
      }
      // A line number is a whole number. (A fraction in the query made the old code throw.)
      start = Math.ceil(start);
      end = Math.ceil(end);

      items = await readItems(fh, snap, start, end, located.parseLine);
    } finally {
      await fh.close();
    }
    if (items === CHANGED) return CHANGED;

    // Merge durably-stored `source` tags onto user turns (see db/message-source.ts) — the
    // REST transcript parser (conversation/transcript.ts) never sets this itself, matching
    // backfillEventsFromTranscript's identical on-disk gap (see cc-sessions.ts's
    // applyDurableSources). Fixes the archived-thread / loadOlder path, where a chat is
    // hydrated ENTIRELY from this endpoint (no live ws to fall back on).
    const userUuids = items.filter((it) => it.kind === 'user' && it.uuid).map((it) => it.uuid as string);
    if (userUuids.length) {
      const sourceByUuid = messageSourceDb.getForUuids(this.deps.db, terminalId, userUuids);
      if (sourceByUuid.size) {
        for (const it of items) {
          if (it.kind === 'user' && it.uuid && sourceByUuid.has(it.uuid)) it.source = sourceByUuid.get(it.uuid);
        }
      }
    }
    return { items, cursor: total, startLine: start, hasMore: start > 0 };
  }

  /**
   * Full-history text search. Newest matches first, one match for each line, `limit` at most.
   * The file is read backward in groups, and the loop gets a turn between groups.
   */
  async search(terminalId: string, query: string, limit = 200): Promise<{ matches: SearchMatch[] }> {
    const q = query.trim().toLowerCase();
    if (!q) return { matches: [] };
    const located = this.deps.locate(terminalId);
    if (!located || located === 'unsupported') return { matches: [] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const matches = await this.searchOnce(located, q, limit);
      if (matches !== CHANGED) return { matches };
      LineIndex.forget(located.file);
    }
    return { matches: [] };
  }

  private async searchOnce(located: TranscriptLocation, q: string, limit: number): Promise<SearchMatch[] | Changed> {
    let fh: fs.promises.FileHandle;
    let snap: LineSnapshot;
    try {
      snap = (await LineIndex.open(located.file)).snapshot();
      fh = await fs.promises.open(located.file, 'r');
    } catch {
      return [];
    }
    const matches: SearchMatch[] = [];
    const slicer = new Slicer();
    try {
      if ((await fh.stat()).ino !== snap.ino) return CHANGED;
      let hi = snap.lineCount;
      while (hi > 0 && matches.length < limit) {
        const lo = groupStartBackward(snap, hi, GROUP_BYTES);
        const lines = await readLines(fh, snap, lo, hi);
        if (lines === CHANGED) return CHANGED;
        slicer.restart();
        for (let i = hi - 1; i >= lo && matches.length < limit; i--) { // newest first
          for (const it of located.parseLine(lines[i - lo])) {
            const hay = `${it.text ?? ''} ${it.toolTitle ?? ''} ${it.toolDetail ?? ''}`;
            const at = hay.toLowerCase().indexOf(q);
            if (at >= 0) {
              matches.push({ line: i, kind: it.kind, snippet: snippetAround(hay, at, q.length) });
              break; // one match per line is enough
            }
          }
          if (slicer.due()) await slicer.pause();
        }
        hi = lo;
      }
    } finally {
      await fh.close();
    }
    return matches;
  }

  /**
   * The items of the newest `limit` lines, synchronously, with no `line` and no `source` field.
   *
   * For the two in-process callers that need the last assistant text and are synchronous
   * (SessionService.agentOutputText and lastTurnTexts). It reads a bounded tail of the file
   * (sessions/tail-read.ts) and reads more only when that tail holds fewer than `limit` lines,
   * so it gives the same items as the old full read gave.
   */
  tailItems(terminalId: string, limit: number): ConvItem[] {
    const located = this.deps.locate(terminalId);
    if (!located || located === 'unsupported') return [];
    let lines: string[];
    try {
      for (let bytes = TAIL_FIRST_BYTES; ; bytes *= 2) {
        const tail = readTail(located.file, bytes);
        // Complete lines only: the last element is '' after a final newline, or a half-written line.
        lines = tail.text.split('\n').slice(0, -1);
        if (lines.length >= limit || !tail.truncatedHead) break;
      }
    } catch {
      return [];
    }
    const items: ConvItem[] = [];
    for (const line of lines.slice(Math.max(0, lines.length - limit))) items.push(...located.parseLine(line));
    return items;
  }
}

/** The first line of the group that ends before line `hi` and holds about `maxBytes` (one line at least). */
function groupStartBackward(snap: LineSnapshot, hi: number, maxBytes: number): number {
  const endOffset = snap.offset(hi);
  let lo = hi - 1;
  while (lo > 0 && endOffset - snap.offset(lo - 1) <= maxBytes) lo--;
  return lo;
}

/** The end line (exclusive) of the group that starts at line `lo`, holds about `maxBytes` and stops at `end`. */
function groupEndForward(snap: LineSnapshot, lo: number, end: number, maxBytes: number): number {
  const startOffset = snap.offset(lo);
  let hi = lo + 1;
  while (hi < end && snap.offset(hi + 1) - startOffset <= maxBytes) hi++;
  return hi;
}

/** The bytes of lines `[lo, hi)`. CHANGED when the file no longer holds all of them. */
async function readBytes(fh: fs.promises.FileHandle, snap: LineSnapshot, lo: number, hi: number): Promise<Buffer | Changed> {
  const { offset, length } = snap.range(lo, hi);
  const buf = Buffer.allocUnsafe(length);
  const n = await readFully(fh, buf, length, offset);
  // Each indexed line ends with a newline. A different last byte means other content is there now.
  if (n !== length || (length > 0 && buf[length - 1] !== 0x0a)) return CHANGED;
  return buf;
}

/** Lines `[lo, hi)` as text: element `k` is line `lo + k`, without its newline. */
async function readLines(fh: fs.promises.FileHandle, snap: LineSnapshot, lo: number, hi: number): Promise<string[] | Changed> {
  const buf = await readBytes(fh, snap, lo, hi);
  if (buf === CHANGED) return CHANGED;
  return buf.toString('utf8').split('\n').slice(0, -1);
}

/** Parses lines `[start, end)`. Each item carries its source line index (enables jump-to). */
async function readItems(
  fh: fs.promises.FileHandle,
  snap: LineSnapshot,
  start: number,
  end: number,
  parseLine: (line: string) => ConvItem[],
): Promise<ConvItem[] | Changed> {
  const items: ConvItem[] = [];
  const slicer = new Slicer();
  for (let lo = start; lo < end; ) {
    const hi = groupEndForward(snap, lo, end, GROUP_BYTES);
    const lines = await readLines(fh, snap, lo, hi);
    if (lines === CHANGED) return CHANGED;
    slicer.restart();
    for (let i = lo; i < hi; i++) {
      for (const it of parseLine(lines[i - lo])) items.push({ ...it, line: i });
      if (slicer.due()) await slicer.pause();
    }
    lo = hi;
  }
  return items;
}

/**
 * The newest line whose top-level `uuid` is `uuid`, or undefined. Backward from the tail in
 * 256 KB windows.
 *
 * A window that does not contain the uuid text is skipped without a parse. That shortcut is used
 * only for a uuid of plain characters, which a JSON writer never escapes; any other uuid is
 * compared after a parse of each line, as the old code did.
 */
async function findUuidLine(fh: fs.promises.FileHandle, snap: LineSnapshot, uuid: string): Promise<number | undefined | Changed> {
  const needle = /^[A-Za-z0-9_.:-]+$/.test(uuid) ? Buffer.from(uuid, 'utf8') : null;
  const slicer = new Slicer();
  for (let hi = snap.lineCount; hi > 0; ) {
    const lo = groupStartBackward(snap, hi, UUID_WINDOW_BYTES);
    const buf = await readBytes(fh, snap, lo, hi);
    if (buf === CHANGED) return CHANGED;
    slicer.restart();
    if (!needle || buf.includes(needle)) {
      const lines = buf.toString('utf8').split('\n').slice(0, -1);
      for (let i = hi - 1; i >= lo; i--) {
        const line = lines[i - lo];
        if (!needle || line.includes(uuid)) {
          try { if (JSON.parse(line)?.uuid === uuid) return i; } catch { /* partial/garbled line */ }
        }
        if (slicer.due()) await slicer.pause();
      }
    }
    hi = lo;
  }
  return undefined;
}

/** A short single-line snippet centered on a match, with ellipses + collapsed whitespace. */
export function snippetAround(text: string, at: number, matchLen: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  // Recompute the match position in the collapsed string (approximate is fine).
  const idx = flat.toLowerCase().indexOf(text.slice(at, at + matchLen).replace(/\s+/g, ' ').trim().toLowerCase());
  const start = Math.max(0, (idx < 0 ? 0 : idx) - 30);
  const end = Math.min(flat.length, (idx < 0 ? 0 : idx) + matchLen + 50);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}
