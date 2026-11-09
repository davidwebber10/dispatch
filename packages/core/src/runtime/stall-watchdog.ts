/**
 * Stall watchdog (engineering program W1-D): a thread whose status is "working" and that sent no
 * frame for longer than a threshold gets a flag. The flag is information for the owner only.
 *
 * The watchdog never kills a process, never changes a status and never sends a message to a
 * thread: its deps hold no function that could. It has no timer either; the daemon's existing
 * 30 s scheduler tick calls `tick()`.
 */

export interface StallDeps {
  /** Threads whose status is `working` and that are not archived. */
  listWorking(): { id: string }[];
  /** Epoch ms of the last frame (structured) or output (PTY) of the thread; undefined when none is known. */
  lastFrameAt(id: string): number | undefined;
  now(): number;
  thresholdMs: number;
  /** One call per edge: flagged (`stalledSince` is a time) or cleared (`stalledSince` is null). */
  onChange(s: StallChange): void;
}

export interface StallState {
  terminalId: string;
  /** Epoch ms from which the thread has been silent: its last frame, or the time the watchdog first saw the turn. */
  stalledSince: number;
  /** Epoch ms of the last frame the thread sent, or null when it sent none in this daemon's life. */
  lastFrameAt: number | null;
}

export interface StallChange {
  terminalId: string;
  stalledSince: number | null;
}

export const DEFAULT_STALL_MINUTES = 10;
/** A gap between two ticks longer than this means the machine slept (the tick is every 30 s). */
export const SLEEP_GAP_MS = 90_000;

/** The threshold: 10 minutes, or `DISPATCH_STALL_MINUTES` when it is a positive number. */
export function stallThresholdMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.DISPATCH_STALL_MINUTES);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_MINUTES) * 60_000;
}

interface Entry {
  /** The frame clock cannot start before this: the first tick that saw the thread working, or the last wake from sleep. */
  baseline: number;
  flagged: StallState | null;
}

export class StallWatchdog {
  private entries = new Map<string, Entry>();
  private lastTickAt: number | null = null;

  constructor(private readonly deps: StallDeps) {}

  tick(): void {
    const now = this.deps.now();
    const slept = this.lastTickAt !== null && now - this.lastTickAt > SLEEP_GAP_MS;
    this.lastTickAt = now;

    const working = new Set(this.deps.listWorking().map((t) => t.id));
    // A thread that left "working" (settled, archived, deleted) has no flag any more.
    for (const [id, entry] of this.entries) {
      if (working.has(id)) continue;
      this.entries.delete(id);
      if (entry.flagged) this.report({ terminalId: id, stalledSince: null });
    }

    for (const id of working) {
      let entry = this.entries.get(id);
      if (!entry) { entry = { baseline: now, flagged: null }; this.entries.set(id, entry); }
      const frame = this.deps.lastFrameAt(id);

      if (entry.flagged) {
        // Only a frame newer than the silence clears a flag. A sleep does not.
        if (frame !== undefined && frame > entry.flagged.stalledSince) {
          entry.flagged = null;
          entry.baseline = Math.min(frame, now);
          this.report({ terminalId: id, stalledSince: null });
        }
        continue;
      }
      // The time the machine slept is not silence: the count starts again at the wake.
      if (slept) { entry.baseline = now; continue; }

      // A frame from an earlier turn is older than the baseline, so the turn's own start counts.
      const last = Math.max(frame ?? 0, entry.baseline);
      if (now - last > this.deps.thresholdMs) {
        entry.flagged = { terminalId: id, stalledSince: last, lastFrameAt: frame ?? null };
        this.report({ terminalId: id, stalledSince: last });
      }
    }
  }

  get(terminalId: string): StallState | null {
    const flagged = this.entries.get(terminalId)?.flagged;
    return flagged ? { ...flagged } : null;
  }

  all(): StallState[] {
    const out: StallState[] = [];
    for (const entry of this.entries.values()) if (entry.flagged) out.push({ ...entry.flagged });
    return out;
  }

  /** A failed broadcast or log write must not stop the check of the other threads. */
  private report(change: StallChange): void {
    try { this.deps.onChange(change); } catch (err) { console.error('[stall] onChange failed:', err); }
  }
}
