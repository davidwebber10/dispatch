import * as pty from 'node-pty';
import { RingBuffer } from './buffer.js';
import { EventEmitter } from 'events';

interface ManagedPty {
  process: pty.IPty;
  buffer: RingBuffer;
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
    const managed: ManagedPty = { process: proc, buffer };
    this.ptys.set(sessionId, managed);

    proc.on('data', (data: string) => {
      buffer.write(data);
      this.emit('data', sessionId, data);
    });

    proc.on('exit', (exitCode: number) => {
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
    managed.process.resize(cols, rows);
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

  getLastActivity(sessionId: string): Date | null {
    return this.ptys.get(sessionId)?.buffer.lastWriteAt ?? null;
  }

  isAlive(sessionId: string): boolean {
    return this.ptys.has(sessionId);
  }

  killAll(): void {
    for (const [id] of this.ptys) {
      this.kill(id);
    }
  }
}
