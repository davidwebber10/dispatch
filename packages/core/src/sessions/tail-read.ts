// packages/core/src/sessions/tail-read.ts
// Bounded reads of a transcript file (W1-E). A Claude Code transcript only grows, and the daemon
// reads it at each turn end, at each spawn and for token totals. Reading the whole file each time
// blocks the event loop for longer as the thread gets older; the answer is almost always in the tail.
import fs from 'fs';

/** Fills `buf[0..length)` from `position`. Returns the bytes read (less than `length` only at the end of the file). */
function readFully(fd: number, buf: Buffer, length: number, position: number): number {
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done);
    if (n <= 0) break;
    done += n;
  }
  return done;
}

/**
 * The last `maxBytes` of `file` as text, whole lines only.
 *
 * When the file is larger than `maxBytes`, the read starts in the middle of the file: the first,
 * partial line is dropped, so the text never starts inside a line or inside a multi-byte character.
 * (A line that starts exactly at the cut is whole, and is kept: one more byte is read to know that.)
 * `truncatedHead` is true when the file has bytes before the text that this call did not return.
 * Throws when the file cannot be opened; callers already treat that as "no transcript".
 */
export function readTail(file: string, maxBytes: number): { text: string; truncatedHead: boolean } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= maxBytes) {
      const buf = Buffer.allocUnsafe(size);
      const n = readFully(fd, buf, size, 0);
      return { text: buf.toString('utf8', 0, n), truncatedHead: false };
    }
    // One byte before the window: a newline there means the window starts on a line start.
    const buf = Buffer.allocUnsafe(maxBytes + 1);
    const n = readFully(fd, buf, maxBytes + 1, size - maxBytes - 1);
    let from: number;
    if (buf[0] === 0x0a) from = 1;
    else {
      const nl = buf.subarray(0, n).indexOf(0x0a, 1);
      from = nl < 0 ? n : nl + 1;
    }
    return { text: buf.toString('utf8', from, n), truncatedHead: true };
  } finally {
    fs.closeSync(fd);
  }
}

/** The bytes `[start, end)` of `file`. Used to read only what was appended since the last read. */
export function readRange(file: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buf = Buffer.allocUnsafe(length);
  if (length === 0) return buf;
  const fd = fs.openSync(file, 'r');
  try {
    const n = readFully(fd, buf, length, start);
    return n === length ? buf : buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}
