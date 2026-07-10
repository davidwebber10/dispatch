import * as pty from 'node-pty';
import { RingBuffer } from './buffer.js';
import { EventEmitter } from 'events';

interface ManagedPty {
  process: pty.IPty;
  buffer: RingBuffer;
  resizeGen: number; // bumped on every client resize — lets nudgeRepaint skip its restore when a real resize interleaves
}

export class PTYManager extends EventEmitter {
  private ptys = new Map<string, ManagedPty>();

  constructor(private defaultEnv: Record<string, string> = {}) {
    super();
  }

  setDefaultEnv(defaultEnv: Record<string, string>): void {
    this.defaultEnv = defaultEnv;
  }

  spawn(sessionId: string, command: string, args: string[], workDir: string, env?: Record<string, string>): number {
    if (this.ptys.has(sessionId)) {
      throw new Error(`PTY already exists for session ${sessionId}`);
    }

    const childEnv: Record<string, string> = {
      ...process.env,
      ...this.defaultEnv,
      ...env,
      TERM: 'xterm-256color',
      COLORTERM: env?.COLORTERM || this.defaultEnv.COLORTERM || process.env.COLORTERM || 'truecolor',
    } as Record<string, string>;

    delete childEnv.NO_COLOR;

    const proc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: workDir,
      env: childEnv,
    });

    const buffer = new RingBuffer();
    const managed: ManagedPty = { process: proc, buffer, resizeGen: 0 };
    this.ptys.set(sessionId, managed);

    proc.onData((data: string) => {
      buffer.write(data);
      this.emit('data', sessionId, data);
    });

    proc.onExit(({ exitCode }) => {
      this.ptys.delete(sessionId);
      this.emit('exit', sessionId, exitCode);
    });

    return proc.pid;
  }

  write(sessionId: string, data: string): void {
    const managed = this.ptys.get(sessionId);
    if (!managed) return;
    managed.process.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const managed = this.ptys.get(sessionId);
    if (!managed) return;
    managed.resizeGen++;
    managed.process.resize(cols, rows);
  }

  getSize(sessionId: string): { cols: number; rows: number } | null {
    const managed = this.ptys.get(sessionId);
    if (!managed) return null;
    return { cols: managed.process.cols, rows: managed.process.rows };
  }

  /**
   * Force the process to repaint its whole screen by delivering a SIGWINCH
   * (grow one row, then restore). Needed after an incomplete scrollback replay:
   * diff-painting TUIs (codex/ratatui) only redraw changed cells, so a viewer
   * attaching mid-stream sees a mostly blank screen until a real size change.
   * The restore is skipped when a client resize lands mid-wiggle — that resize
   * is itself a size change, so it triggers the repaint AND sets the right size.
   */
  nudgeRepaint(sessionId: string): void {
    const managed = this.ptys.get(sessionId);
    if (!managed) return;
    const { cols, rows } = managed.process;
    const gen = managed.resizeGen;
    try { managed.process.resize(cols, rows + 1); } catch { return; }
    setTimeout(() => {
      const still = this.ptys.get(sessionId);
      if (still !== managed || managed.resizeGen !== gen) return;
      try { managed.process.resize(cols, rows); } catch { /* process gone */ }
    }, 150);
  }

  kill(sessionId: string): void {
    const managed = this.ptys.get(sessionId);
    if (!managed) return;
    managed.process.kill();
    this.ptys.delete(sessionId);
  }

  getBuffer(sessionId: string, maxBytes?: number): string {
    return this.ptys.get(sessionId)?.buffer.getContents(maxBytes) ?? '';
  }

  /** Whether getBuffer(sessionId, maxBytes) covers the process's full output history. */
  isReplayComplete(sessionId: string, maxBytes?: number): boolean {
    return this.ptys.get(sessionId)?.buffer.isReplayComplete(maxBytes) ?? true;
  }

  getLastActivity(sessionId: string): Date | null {
    return this.ptys.get(sessionId)?.buffer.lastWriteAt ?? null;
  }

  isAlive(sessionId: string): boolean {
    return this.ptys.has(sessionId);
  }

  /** Ids of all currently-live PTYs (terminal ids for modern terminals). */
  liveIds(): string[] {
    return [...this.ptys.keys()];
  }

  killAll(): void {
    for (const [id] of this.ptys) {
      this.kill(id);
    }
  }
}
