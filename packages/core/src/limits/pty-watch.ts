// packages/core/src/limits/pty-watch.ts
// Finds a usage-limit banner in a CLI (PTY) thread's output. A TUI repaints the screen, and an
// agent can quote the banner in prose, so a match counts only after the terminal stays quiet:
// any new output that is not the banner itself restarts the wait.
import { detectBannerLimit, detectCodexBannerLimit, textAfterBanner, textAfterCodexBanner, type UsageLimit } from './detect.js';

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

/** One CLI's banner: how to find it, and how much screen may follow it before it counts as a quote. */
export interface PtyDetector {
  provider: string;
  detect(output: string, now: number): UsageLimit | null;
  /** Letters and digits on the screen after the last banner. */
  textAfter(output: string): number;
  maxTrailing: number;
}

/**
 * The banners of the CLIs that stop on a usage limit in a terminal. Claude's prompt box is small.
 * Codex repaints a taller footer (model line, context left, composer hint) under its banner, so it
 * is allowed more letters after it.
 */
export const PTY_DETECTORS: PtyDetector[] = [
  { provider: 'claude-code', detect: detectBannerLimit, textAfter: textAfterBanner, maxTrailing: MAX_TRAILING_LETTERS },
  { provider: 'codex', detect: detectCodexBannerLimit, textAfter: textAfterCodexBanner, maxTrailing: 400 },
];

export interface PtyLimitWatcherDeps {
  isIdle(terminalId: string): boolean;
  /** `provider` names the CLI whose banner it was (a PtyDetector.provider). The caller parks only a terminal of that type. */
  onLimit(terminalId: string, limit: UsageLimit, provider: string): void;
  confirmMs?: number;
  /** Default: PTY_DETECTORS. */
  detectors?: PtyDetector[];
}

export class PtyLimitWatcher {
  private tails = new Map<string, string>();
  private pending = new Map<string, NodeJS.Timeout>();
  private reported = new Map<string, { message: string; until: number }>();

  private readonly detectors: PtyDetector[];

  constructor(private readonly d: PtyLimitWatcherDeps) { this.detectors = d.detectors ?? PTY_DETECTORS; }

  /** The first detector that finds a banner in `output`. */
  private find(output: string, now: number): { limit: UsageLimit; detector: PtyDetector } | null {
    for (const detector of this.detectors) {
      const limit = detector.detect(output, now);
      if (limit) return { limit, detector };
    }
    return null;
  }

  feed(terminalId: string, chunk: string): void {
    const tail = ((this.tails.get(terminalId) ?? '') + chunk).slice(-WINDOW);
    this.tails.set(terminalId, tail);
    if (this.pending.has(terminalId)) {
      // The banner painted again, or blank screen codes: still quiet. Anything else: not quiet.
      if (!this.find(chunk, Date.now()) && chunk.replace(ANSI, '').trim()) this.arm(terminalId);
      return;
    }
    const hit = this.find(tail, Date.now());
    if (hit && !this.isRepaint(terminalId, hit.limit)) this.arm(terminalId);
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
      const hit = this.find(tail, Date.now());
      if (!hit || hit.detector.textAfter(tail) > hit.detector.maxTrailing || this.isRepaint(terminalId, hit.limit)) { this.tails.delete(terminalId); return; }
      const { limit, detector } = hit;
      // A repaint resets the monitor's idle clock: wait again instead of dropping a real stop.
      if (!this.d.isIdle(terminalId)) {
        if (retries < MAX_BUSY_RETRIES) this.arm(terminalId, retries + 1);
        else this.tails.delete(terminalId);
        return;
      }
      this.tails.delete(terminalId);
      this.reported.set(terminalId, { message: limit.message, until: (limit.resetsAt ?? Date.now() + UNKNOWN_RESET_MS) + REPAINT_GRACE_MS });
      this.d.onLimit(terminalId, limit, detector.provider);
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
