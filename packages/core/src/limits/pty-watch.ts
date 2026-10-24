// packages/core/src/limits/pty-watch.ts
// Finds a usage-limit banner in a CLI (PTY) thread's output. A TUI repaints the screen, and an
// agent can quote the banner in prose, so a match counts only after the terminal stays quiet:
// any new output that is not the banner itself restarts the wait.
import { detectBannerLimit, textAfterBanner, type UsageLimit } from './detect.js';

const WINDOW = 2048;
/** A reported banner is ignored again until its reset has passed by this much (repaints). */
const REPAINT_GRACE_MS = 10 * 60_000;
/** The same, when the banner gave no readable reset. */
const UNKNOWN_RESET_MS = 35 * 60_000;
/** More letters than this after the banner means the agent kept talking: it was a quote. */
const MAX_TRAILING_LETTERS = 120;
/** Times a confirmation waits for a busy terminal (a repaint resets its idle clock) before giving up. */
const MAX_BUSY_RETRIES = 6;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b\([A-Za-z]/g;

export interface PtyLimitWatcherDeps {
  isIdle(terminalId: string): boolean;
  onLimit(terminalId: string, limit: UsageLimit): void;
  confirmMs?: number;
}

export class PtyLimitWatcher {
  private tails = new Map<string, string>();
  private pending = new Map<string, NodeJS.Timeout>();
  private reported = new Map<string, { message: string; until: number }>();

  constructor(private readonly d: PtyLimitWatcherDeps) {}

  feed(terminalId: string, chunk: string): void {
    const tail = ((this.tails.get(terminalId) ?? '') + chunk).slice(-WINDOW);
    this.tails.set(terminalId, tail);
    if (this.pending.has(terminalId)) {
      // The banner painted again, or blank screen codes: still quiet. Anything else: not quiet.
      if (!detectBannerLimit(chunk, Date.now()) && chunk.replace(ANSI, '').trim()) this.arm(terminalId);
      return;
    }
    const limit = detectBannerLimit(tail, Date.now());
    if (limit && !this.isRepaint(terminalId, limit)) this.arm(terminalId);
  }

  private isRepaint(terminalId: string, limit: UsageLimit): boolean {
    const last = this.reported.get(terminalId);
    return !!last && last.message === limit.message && Date.now() < last.until;
  }

  private arm(terminalId: string, retries = 0): void {
    const old = this.pending.get(terminalId);
    if (old) clearTimeout(old);
    this.pending.set(terminalId, setTimeout(() => {
      this.pending.delete(terminalId);
      const tail = this.tails.get(terminalId) ?? '';
      // Read the whole banner now: chunks may have split it, so the first look can lack the time.
      const limit = detectBannerLimit(tail, Date.now());
      if (!limit || textAfterBanner(tail) > MAX_TRAILING_LETTERS || this.isRepaint(terminalId, limit)) { this.tails.delete(terminalId); return; }
      // A repaint resets the monitor's idle clock: wait again instead of dropping a real stop.
      if (!this.d.isIdle(terminalId)) {
        if (retries < MAX_BUSY_RETRIES) this.arm(terminalId, retries + 1);
        else this.tails.delete(terminalId);
        return;
      }
      this.tails.delete(terminalId);
      this.reported.set(terminalId, { message: limit.message, until: (limit.resetsAt ?? Date.now() + UNKNOWN_RESET_MS) + REPAINT_GRACE_MS });
      this.d.onLimit(terminalId, limit);
    }, this.d.confirmMs ?? 5000));
  }

  /** The terminal ended, or the owner took over: drop any pending detection. */
  forget(terminalId: string): void {
    const t = this.pending.get(terminalId);
    if (t) clearTimeout(t);
    this.pending.delete(terminalId);
    this.tails.delete(terminalId);
    this.reported.delete(terminalId);
  }
}
