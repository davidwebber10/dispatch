/**
 * Escape state a mid-stream replay window cannot inherit: leave the alt screen,
 * reset SGR, reset the scroll region, home the cursor. A window that starts in
 * the middle of the lifetime stream never saw the sequences that set those modes,
 * so a stray `\x1b[?1049l` inside it can blank the whole screen. Prefixed ONLY
 * when the slice starts after byte 0 — a complete-from-zero replay stays
 * byte-identical to what the daemon has always sent.
 */
export const REPLAY_STATE_PREAMBLE = '\x1b[?1049l\x1b[0m\x1b[r\x1b[H';

const LF = 0x0a;
const ESC = 0x1b;
const CSI_INTRO = 0x5b; // '['
const OSC_INTRO = 0x5d; // ']'
const BEL = 0x07;
const ST_FINAL = 0x5c; // '\' of the ESC \ string terminator

/** How far back a slice looks for an unterminated escape sequence. */
const ESCAPE_LOOKBEHIND = 256;

/**
 * Index just past the final byte of the escape sequence that starts at `esc`,
 * or -1 when the sequence never terminates inside `buf`.
 */
function sequenceEnd(buf: Buffer, esc: number): number {
  const intro = buf[esc + 1];
  if (intro === undefined) return -1;
  if (intro === CSI_INTRO) {
    for (let i = esc + 2; i < buf.length; i++) {
      if (buf[i] >= 0x40 && buf[i] <= 0x7e) return i + 1;
    }
    return -1;
  }
  if (intro === OSC_INTRO) {
    for (let i = esc + 2; i < buf.length; i++) {
      if (buf[i] === BEL) return i + 1;
      if (buf[i] === ESC && buf[i + 1] === ST_FINAL) return i + 2;
    }
    return -1;
  }
  if (intro >= 0x20 && intro <= 0x2f) {
    // ESC ( B and friends: intermediate bytes, then a final byte.
    for (let i = esc + 2; i < buf.length; i++) {
      if (buf[i] >= 0x30 && buf[i] <= 0x7e) return i + 1;
    }
    return -1;
  }
  return esc + 2; // plain two-byte escape (ESC M, ESC 7, …)
}

/**
 * Move `cut` forward until it is not inside an escape sequence. The bytes before
 * the cut are still available (they are the part of the ring the slice drops), so
 * a bounded backward scan can tell whether a sequence is still open there.
 */
function skipPartialEscape(buf: Buffer, cut: number): number {
  const from = Math.max(0, cut - ESCAPE_LOOKBEHIND);
  let esc = -1;
  for (let i = cut - 1; i >= from; i--) {
    if (buf[i] === ESC) { esc = i; break; }
  }
  if (esc === -1) return cut;
  const end = sequenceEnd(buf, esc);
  if (end !== -1 && end <= cut) return cut; // that sequence closed before the cut
  if (end === -1) return buf.length; // open to the very end — nothing safe to emit
  return end;
}

/**
 * The first byte a slice may start on, at or after `cut`.
 * 1. Advance forward past the next `\n`, so a replay never opens with a partial line.
 * 2. If there is no `\n` ahead, at least never start inside an escape sequence.
 * Both rules only ever return LESS data, which is always safe.
 */
function alignStart(buf: Buffer, cut: number): number {
  if (cut > 0 && buf[cut - 1] === LF) return cut; // already on a line start
  const nl = buf.indexOf(LF, cut);
  if (nl !== -1) return nl + 1;
  return skipPartialEscape(buf, cut);
}

export class RingBuffer {
  private chunks: string[] = [];
  private totalSize = 0;
  private maxSize: number;
  private dropped = false; // oldest data has been trimmed — contents no longer start at process spawn
  private evictedBytes = 0; // monotonic count of bytes trimmed from the head
  // True when the retained head is a KNOWN-safe emit point (the first byte written
  // after a trimToNow — the start of a post-resize repaint frame), so getSlice must
  // not align it forward to the next newline (which could skip the whole retained
  // window). Ring eviction clears it: a shifted-off chunk leaves an arbitrary head.
  private headSafe = false;
  public lastWriteAt: Date | null = null;

  // 4MB ≈ hours of TUI diff-frames: codex's spinner floods the ring, and the
  // scrolled-away transcript survives a reattach only if it's still in here.
  constructor(maxBytes: number = 4_000_000) {
    this.maxSize = maxBytes;
  }

  write(data: string): void {
    this.chunks.push(data);
    this.totalSize += Buffer.byteLength(data, 'utf8');
    this.lastWriteAt = new Date();
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      const removedBytes = Buffer.byteLength(removed, 'utf8');
      this.totalSize -= removedBytes;
      this.evictedBytes += removedBytes;
      this.dropped = true;
      this.headSafe = false;
    }
  }

  /**
   * Whether getContents(maxBytes) would return everything the process has ever
   * written. False once the ring has trimmed old data OR the caller's cap cuts
   * the tail — either way a replay can't fully reconstruct a TUI's screen.
   */
  isReplayComplete(maxBytes?: number): boolean {
    if (this.dropped) return false;
    if (maxBytes && maxBytes > 0 && this.totalSize > maxBytes) return false;
    return true;
  }

  /**
   * The ring's current byte count. This is the RETAINED size — what getContents()
   * would return with no cap — not the lifetime total of everything ever written:
   * write()'s trim loop already decrements totalSize as it evicts old chunks, so
   * once the ring has wrapped this is already "what a full replay would return",
   * no separate accounting needed.
   */
  size(): number {
    return this.totalSize;
  }

  /**
   * Total bytes the process has ever written, evicted ones included. Monotonic
   * for the life of the ring (only clear() resets it), so a client can compare
   * two replays and tell which one is older.
   */
  totalWritten(): number {
    return this.evictedBytes + this.totalSize;
  }

  /** Absolute position, in the lifetime stream, of the ring's first retained byte. */
  startOffset(): number {
    return this.evictedBytes;
  }

  getContents(maxBytes?: number): string {
    if (!maxBytes || maxBytes <= 0 || this.totalSize <= maxBytes) {
      return this.chunks.join('');
    }

    const tail: string[] = [];
    let size = 0;

    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const chunk = this.chunks[i];
      const chunkSize = Buffer.byteLength(chunk, 'utf8');
      if (size + chunkSize <= maxBytes) {
        tail.unshift(chunk);
        size += chunkSize;
        continue;
      }

      const remaining = maxBytes - size;
      if (remaining > 0) {
        const bytes = Buffer.from(chunk, 'utf8');
        tail.unshift(bytes.subarray(Math.max(0, bytes.length - remaining)).toString('utf8'));
      }
      break;
    }

    return tail.join('');
  }

  /**
   * getContents() plus the absolute position the returned bytes start at, so a
   * client can tell whether a replay is older, newer or disjoint from what it
   * already shows.
   *
   * `startOffset` is the position of the first REAL byte of `data` — the state
   * preamble that a mid-stream slice carries is not counted. When the slice does
   * not start at byte 0 the head is aligned forward (never a partial line, never
   * inside an escape sequence) and REPLAY_STATE_PREAMBLE is prefixed. A slice
   * that starts at 0 is returned exactly as getContents() would return it.
   */
  getSlice(maxBytes?: number): { data: string; startOffset: number } {
    const capped = !!maxBytes && maxBytes > 0 && this.totalSize > maxBytes;
    if (!capped && this.evictedBytes === 0) {
      return { data: this.chunks.join(''), startOffset: 0 };
    }

    const buf = Buffer.from(this.chunks.join(''), 'utf8');
    const cut = capped ? Math.max(0, buf.length - maxBytes!) : 0;
    // An uncapped slice whose head is a trimToNow boundary starts at a fresh
    // post-resize repaint frame — emitting from byte 0 is safe and aligning
    // forward could throw the whole retained window away.
    const start = cut === 0 && this.headSafe ? 0 : alignStart(buf, cut);
    return {
      data: REPLAY_STATE_PREAMBLE + buf.subarray(start).toString('utf8'),
      startOffset: this.evictedBytes + start,
    };
  }

  clear(): void {
    this.chunks = [];
    this.totalSize = 0;
    this.lastWriteAt = null;
    this.dropped = false;
    this.evictedBytes = 0;
    this.headSafe = false;
  }

  /**
   * Evict everything retained while keeping the lifetime counters monotonic.
   * Called on a width-changing resize (see PTYManager.resize): bytes wrapped for
   * another terminal width can only ever replay as rewrapped noise, so they leave
   * the replayable window entirely. The full conversation still lives in the
   * harness's own transcript (the Pretty view) — this ring only owes the viewer a
   * faithful terminal, and a faithful terminal shows nothing rather than garbage.
   * An already-empty ring is a no-op, so the flags stay untouched.
   */
  trimToNow(): void {
    if (this.totalSize === 0) return;
    this.evictedBytes += this.totalSize;
    this.totalSize = 0;
    this.chunks = [];
    this.dropped = true; // a replay can no longer reconstruct the screen → callers nudge a repaint
    this.headSafe = true; // the next write starts a post-resize repaint frame
  }
}
