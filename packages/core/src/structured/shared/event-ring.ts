// packages/core/src/structured/shared/event-ring.ts
//
// The replay ring of one structured session: the recent Claude-shaped events that a (re)connecting
// viewer gets first. One class for the three managers (Claude, Codex, ACP), in place of the twelve
// places that each trimmed a plain array.
//
// Two limits, both applied oldest-first: a count (5,000 events) and a size (8 MB). The size is the
// length of each event as JSON, which is what a replay sends. It is counted in UTF-16 units, not
// bytes on the wire: close enough for a limit, and it costs no second encode.

export const DEFAULT_MAX_EVENTS = 5000;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface EventRingOptions {
  maxEvents?: number;
  maxBytes?: number;
}

export interface PushOptions {
  /** The JSON length of the event, when the caller has it already (a parsed stdout line). */
  size?: number;
  /** True for an event the daemon wrote itself (a user echo, a notice): `lastPushAt` does not move. */
  quiet?: boolean;
}

function sizeOf(event: unknown): number {
  try { return JSON.stringify(event)?.length ?? 0; } catch { return 0; }
}

export class EventRing {
  private events: unknown[] = [];
  private sizes: number[] = [];
  private total = 0;
  private pushCount = 0;
  private pushedAt: number | undefined;
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  /**
   * Called with each event that `push` adds, after it is in the ring. Not called for seeded
   * history, and not for the changes that `compact` makes. The message journal writes from it
   * (journal/recorder.ts, W3-D): it sets `seq` on the event that finished an item, so the hook
   * runs before the manager emits the event to the viewers.
   */
  onCommit?: (event: unknown) => void;

  constructor(opts: EventRingOptions = {}) {
    this.maxEvents = Math.max(1, opts.maxEvents ?? DEFAULT_MAX_EVENTS);
    this.maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  /** How many events the ring holds. */
  get length(): number { return this.events.length; }
  /** The JSON size of the events the ring holds (see the file comment for the unit). */
  get bytes(): number { return this.total; }
  /** How many events `push` has added in the ring's life. A caller keeps it as a mark for `compact`. */
  get pushes(): number { return this.pushCount; }
  /** Epoch ms of the last push that was not quiet, or undefined. Seeded history does not count. */
  get lastPushAt(): number | undefined { return this.pushedAt; }

  push(event: unknown, opts: PushOptions = {}): void {
    const size = opts.size ?? sizeOf(event);
    this.events.push(event);
    this.sizes.push(size);
    this.total += size;
    this.pushCount += 1;
    if (!opts.quiet) this.pushedAt = Date.now();
    this.trim();
    this.onCommit?.(event);
  }

  /** Put history in the ring (a resume backfill). It is not a sign of life: `lastPushAt` stays. */
  seed(events: unknown[]): void {
    for (const event of events) {
      const size = sizeOf(event);
      this.events.push(event);
      this.sizes.push(size);
      this.total += size;
    }
    this.trim();
  }

  /** A copy of the events, oldest first. */
  snapshot(): unknown[] { return [...this.events]; }

  /** A copy of the newest `n` events (all of them when the ring has fewer). */
  tail(n: number): unknown[] {
    return n >= this.events.length ? [...this.events] : this.events.slice(this.events.length - n);
  }

  /** The ring's own array, for a read that must not copy 5,000 entries. The caller must not change it. */
  view(): readonly unknown[] { return this.events; }

  /**
   * Remove the stream deltas of one finished message. `isDeltaOf` returns the id of the message
   * that an event is a delta of, or null. Every event whose id equals `messageId` is removed.
   * With a `replacement`, that one event takes the place of the first removed event (the
   * managers that get no whole message use it to keep the text as one delta).
   * `sincePushes` is the value of `pushes` from before the message's first delta was pushed: only
   * the events pushed after it are looked at, so the cost follows the message, not the ring.
   * Returns how many events were removed.
   */
  compact(isDeltaOf: (event: unknown) => string | null, messageId: string, replacement?: unknown, sincePushes?: number): number {
    const window = sincePushes === undefined ? this.events.length : Math.min(this.events.length, Math.max(0, this.pushCount - sincePushes));
    const from = this.events.length - window;
    let first = -1;
    let removed = 0;
    const events: unknown[] = [];
    const sizes: number[] = [];
    for (let i = from; i < this.events.length; i++) {
      if (isDeltaOf(this.events[i]) === messageId) {
        if (first < 0) first = events.length;
        removed += 1;
        this.total -= this.sizes[i];
      } else {
        events.push(this.events[i]);
        sizes.push(this.sizes[i]);
      }
    }
    if (removed === 0) return 0;
    if (replacement !== undefined) {
      const size = sizeOf(replacement);
      events.splice(first, 0, replacement);
      sizes.splice(first, 0, size);
      this.total += size;
    }
    this.events.length = from;
    this.sizes.length = from;
    for (let i = 0; i < events.length; i++) { this.events.push(events[i]); this.sizes.push(sizes[i]); }
    return removed;
  }

  /** Drop the oldest events until both limits hold. The newest event always stays. */
  private trim(): void {
    let drop = Math.max(0, this.events.length - this.maxEvents);
    let total = this.total;
    for (let i = 0; i < drop; i++) total -= this.sizes[i];
    while (total > this.maxBytes && drop < this.events.length - 1) total -= this.sizes[drop++];
    if (drop === 0) return;
    this.events.splice(0, drop);
    this.sizes.splice(0, drop);
    this.total = total;
  }
}
