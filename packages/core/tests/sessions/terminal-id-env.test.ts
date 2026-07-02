import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { StructuredSessionManager } from '../../src/structured/manager.js';
import { TERMINAL_ID_ENV_VAR } from '../../src/auth/shim.js';

// Captures the env handed to the PTY spawn; all other PTY ops are safe no-ops
// (mirrors injection-wiring.test.ts's CapturingPty).
class CapturingPty extends PTYManager {
  calls: { id: string; env?: Record<string, string> }[] = [];
  private pid = 1;
  override spawn(id: string, _command: string, _args: string[], _workDir: string, env?: Record<string, string>): number {
    this.calls.push({ id, env });
    return this.pid++;
  }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

// Captures the env handed to the structured-manager spawn, without launching a real claude process.
class CapturingStructuredManager extends StructuredSessionManager {
  calls: { terminalId: string; env?: Record<string, string> }[] = [];
  override isAlive(): boolean { return false; }
  override spawn(terminalId: string, opts: { env?: Record<string, string> }): number {
    this.calls.push({ terminalId, env: opts.env });
    return 999;
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-term-env-'));
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: tmpDir });
  const pty = new CapturingPty();
  const svc = new SessionService(db, pty, path.join(tmpDir, 'mcp.json'));
  return { svc, pty };
}

describe('DISPATCH_TERMINAL_ID env threading', () => {
  it('passes the terminal id as env on a plain PTY spawn', () => {
    const { svc, pty } = makeService();
    const terminal = svc.createTerminal('s1', 'shell', 'Shell');

    expect(pty.calls).toHaveLength(1);
    expect(pty.calls[0].id).toBe(terminal.id);
    expect(pty.calls[0].env).toEqual({ [TERMINAL_ID_ENV_VAR]: terminal.id });
  });

  it('passes the terminal id as env on a structured (stream-json) spawn', () => {
    const { svc } = makeService();
    const structured = new CapturingStructuredManager();
    svc.setStructuredManager(structured);
    svc.setStructuredCommandOverride({ command: 'true', args: [] });

    const terminal = svc.createTerminal('s1', 'claude-code', 'Implementer', false, undefined, undefined, {
      transport: 'structured',
      role: 'agent',
      agentType: 'implementer',
    });

    expect(structured.calls).toHaveLength(1);
    expect(structured.calls[0].terminalId).toBe(terminal.id);
    expect(structured.calls[0].env).toEqual({ [TERMINAL_ID_ENV_VAR]: terminal.id });
  });
});
