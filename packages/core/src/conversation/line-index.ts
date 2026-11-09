// packages/core/src/conversation/line-index.ts
// The byte offset of each line start in one transcript file (W2-B).
//
// A transcript page used to read the whole file and split it, synchronously, for each request. With
// this index a page reads only the bytes of its own lines. The index is built once in 1 MB chunks,
// yields to the event loop between chunks, and after that reads only the bytes that were appended.
import fs from 'fs';

/** Bytes per read while the index is built. The loop gets a turn between two chunks. */
const CHUNK_BYTES = 1024 * 1024;
/** How many files keep an index in memory. The least recently opened is dropped first. */
const MAX_CACHED = 8;
const NEWLINE = 0x0a;

/** Lets timers and I/O callbacks run before the next slice of work. */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Fills `buf[0..length)` from `position` of an open file. Returns the bytes read; the number is
 * less than `length` only when the file ends first.
 */
export async function readFully(fh: fs.promises.FileHandle, buf: Buffer, length: number, position: number): Promise<number> {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead <= 0) break;
    done += bytesRead;
  }
  return done;
}

/**
 * A fixed view of the index: the line count and the line offsets at the moment it was taken.
 * An append after that moment does not change it, and a reset of the index leaves it intact, so a
 * reader can use it across several `await` points.
 */
export class LineSnapshot {
  constructor(
    /** `starts[i]` is the byte offset of line `i`; `starts[lineCount]` is the end of the last complete line. */
    private readonly starts: number[],
    readonly lineCount: number,
    /** The inode that the offsets belong to. A reader compares it with the file that it opens. */
    readonly ino: number,
  ) {}

  /** The byte offset of the start of line `line` (`line === lineCount` gives the end of the last complete line). */
  offset(line: number): number {
    if (!Number.isInteger(line) || line < 0 || line > this.lineCount) throw new RangeError(`line ${line} is outside 0..${this.lineCount}`);
    return this.starts[line];
  }

  /** The bytes of lines `[startLine, endLine)`, each with its newline. */
  range(startLine: number, endLine: number): { offset: number; length: number } {
    if (endLine < startLine) throw new RangeError(`endLine ${endLine} is before startLine ${startLine}`);
    const offset = this.offset(startLine);
    return { offset, length: this.offset(endLine) - offset };
  }
}

export class LineIndex {
  /** file path -> index, in order of use (the first key is the least recently used). */
  private static cache = new Map<string, LineIndex>();

  /** Line start offsets. Only appended to; a reset makes a new array (see LineSnapshot). */
  private starts: number[] = [0];
  /** Bytes of the file that the scan has seen. Larger than the last line start when a line is half-written. */
  private scanned = 0;
  private ino = -1;
  private dev = -1;
  /** The refresh that runs now, or the last one. Each refresh waits for it, so two never scan at once. */
  private tail: Promise<void> = Promise.resolve();

  private constructor(readonly file: string) {}

  /**
   * The index of `file`, up to date with the file's size now. Rejects when the file cannot be
   * opened (the caller treats that as "no transcript").
   */
  static async open(file: string): Promise<LineIndex> {
    let index = LineIndex.cache.get(file);
    if (index) LineIndex.cache.delete(file);
    else index = new LineIndex(file);
    LineIndex.cache.set(file, index);
    while (LineIndex.cache.size > MAX_CACHED) {
      const oldest = LineIndex.cache.keys().next().value;
      if (oldest === undefined) break;
      LineIndex.cache.delete(oldest);
    }
    try {
      await index.refresh();
    } catch (err) {
      if (LineIndex.cache.get(file) === index) LineIndex.cache.delete(file);
      throw err;
    }
    return index;
  }

  /** Drops the cached index of `file`. The next `open` builds it again from byte 0. */
  static forget(file: string): void {
    LineIndex.cache.delete(file);
  }

  /** Drops every cached index. For tests. */
  static clearCache(): void {
    LineIndex.cache.clear();
  }

  /** How many indexes are in memory. For tests. */
  static cachedCount(): number {
    return LineIndex.cache.size;
  }

  /** Complete lines only: a last line with no newline yet is not counted. */
  get lineCount(): number {
    return this.starts.length - 1;
  }

  /** The bytes of lines `[startLine, endLine)`, each with its newline. */
  range(startLine: number, endLine: number): { offset: number; length: number } {
    return this.snapshot().range(startLine, endLine);
  }

  snapshot(): LineSnapshot {
    return new LineSnapshot(this.starts, this.starts.length - 1, this.ino);
  }

  /** Reads the bytes after the last indexed offset. Starts again from byte 0 when the file was replaced or cut. */
  refresh(): Promise<void> {
    const run = this.tail.then(() => this.scan(), () => this.scan());
    this.tail = run.catch(() => undefined);
    return run;
  }

  private reset(): void {
    this.starts = [0];
    this.scanned = 0;
  }

  private async scan(): Promise<void> {
    const fh = await fs.promises.open(this.file, 'r');
    try {
      const stat = await fh.stat();
      if (stat.ino !== this.ino || stat.dev !== this.dev || stat.size < this.scanned) this.reset();
      this.ino = stat.ino;
      this.dev = stat.dev;
      const size = stat.size;
      if (size === this.scanned && this.starts.length === 1) return;

      const buf = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_BYTES, size - this.scanned)));

      // A file that was written again in place can be as large as before, or larger. The byte
      // before the last indexed line start must still be a newline; if it is not, the offsets are
      // those of the old content.
      const lastStart = this.starts[this.starts.length - 1];
      if (lastStart > 0) {
        const n = await readFully(fh, buf, 1, lastStart - 1);
        if (n !== 1 || buf[0] !== NEWLINE) this.reset();
      }

      while (this.scanned < size) {
        const want = Math.min(buf.length, size - this.scanned);
        const { bytesRead } = await fh.read(buf, 0, want, this.scanned);
        if (bytesRead <= 0) break; // the file became shorter during the scan; the next refresh resets
        const chunk = buf.subarray(0, bytesRead);
        const base = this.scanned;
        const starts = this.starts;
        for (let at = chunk.indexOf(NEWLINE); at !== -1; at = chunk.indexOf(NEWLINE, at + 1)) starts.push(base + at + 1);
        this.scanned = base + bytesRead;
        if (this.scanned < size) await yieldToLoop();
      }
    } finally {
      await fh.close();
    }
  }
}
