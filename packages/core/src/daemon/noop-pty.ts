import { PTYManager } from '../pty/manager.js';

/** What the daemon needs from the PTY manager. Today it is the class itself; tests pass a subclass. */
export type PtyLike = PTYManager;

/**
 * A no-op PTY manager for testing. Spawn always succeeds with a fake pid and nothing runs
 * (the session records the terminal as alive until it is killed).
 */
export class NoopPTYManager extends PTYManager {
  private nextPid = 1000;
  private alive = new Set<string>();

  override spawn(sessionId: string): number {
    this.alive.add(sessionId);
    return this.nextPid++;
  }
  override write(): void {}
  override resize(): void {}
  override kill(sessionId: string): void { this.alive.delete(sessionId); }
  override getBuffer(): string { return ''; }
  override getBufferSize(): number { return 0; }
  override getLastActivity(): Date | null { return null; }
  override isAlive(sessionId: string): boolean { return this.alive.has(sessionId); }
  override killAll(): void { this.alive.clear(); }
}
