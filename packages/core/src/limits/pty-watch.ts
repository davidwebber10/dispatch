// packages/core/src/limits/pty-watch.ts
// Finds a usage-limit banner in a CLI (PTY) thread's output. A TUI repaints the screen, and an
// agent can quote the banner in prose, so a match counts only when the terminal is quiet after it.
import { detectBannerLimit, type UsageLimit } from './detect.js';

const WINDOW = 2048;
/** Distinct banners one terminal may report per window of time: a repaint is the same banner. */
const SAME_BANNER_MS = 60_000;

export interface PtyLimitWatcherDeps {
  isIdle(terminalId: string): boolean;
  onLimit(terminalId: string, limit: UsageLimit): void;
  confirmMs?: number;
}

export class PtyLimitWatcher {
  private tails = new Map<string, string>();
  private pending = new Map<string, NodeJS.Timeout>();
  private lastReported = new Map<string, { message: string; at: number }>();

  constructor(private readonly d: PtyLimitWatcherDeps) {}

  feed(terminalId: string, chunk: string): void {
    const tail = ((this.tails.get(terminalId) ?? '') + chunk).slice(-WINDOW);
    this.tails.set(terminalId, tail);
    if (this.pending.has(terminalId)) return;
    const limit = detectBannerLimit(tail, Date.now());
    if (!limit) return;
    const last = this.lastReported.get(terminalId);
    if (last && last.message === limit.message && Date.now() - last.at < SAME_BANNER_MS) return;
    this.pending.set(terminalId, setTimeout(() => {
      this.pending.delete(terminalId);
      this.tails.delete(terminalId);
      if (!this.d.isIdle(terminalId)) return;
      this.lastReported.set(terminalId, { message: limit.message, at: Date.now() });
      this.d.onLimit(terminalId, limit);
    }, this.d.confirmMs ?? 5000));
  }

  forget(terminalId: string): void {
    const t = this.pending.get(terminalId);
    if (t) clearTimeout(t);
    this.pending.delete(terminalId);
    this.tails.delete(terminalId);
    this.lastReported.delete(terminalId);
  }
}
