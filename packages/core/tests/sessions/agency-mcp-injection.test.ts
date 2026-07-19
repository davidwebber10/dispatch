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
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';

// Captures the argv handed to the PTY; all other PTY ops are safe no-ops
// (mirrors injection-wiring.test.ts's CapturingPty).
class CapturingPty extends PTYManager {
  calls: { id: string; command: string; args: string[] }[] = [];
  private pid = 1;
  override spawn(id: string, command: string, args: string[]): number {
    this.calls.push({ id, command, args });
    return this.pid++;
  }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

// Captures the command/args/env handed to the structured manager's spawn, without
// launching a real claude/codex process (mirrors terminal-id-env.test.ts).
class CapturingClaudeManager extends StructuredSessionManager {
  calls: { terminalId: string; command: string; args: string[]; env?: Record<string, string> }[] = [];
  override isAlive(): boolean { return false; }
  override spawn(terminalId: string, opts: { command: string; args: string[]; env?: Record<string, string> }): number {
    this.calls.push({ terminalId, command: opts.command, args: opts.args, env: opts.env });
    return 999;
  }
}

class CapturingCodexManager extends CodexStructuredSessionManager {
  calls: { terminalId: string; command: string; args: string[]; env?: Record<string, string> }[] = [];
  override isAlive(): boolean { return false; }
  override spawn(terminalId: string, opts: { command: string; args: string[]; env?: Record<string, string> }): number {
    this.calls.push({ terminalId, command: opts.command, args: opts.args, env: opts.env });
    return 998;
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agency-inj-'));
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function makeService(configPath: string) {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: tmpDir });
  const pty = new CapturingPty();
  const svc = new SessionService(db, pty, configPath);
  return { svc, pty, db };
}

describe('agency MCP: caller identity + standard injection path', () => {
  it('a coordinator (claude-code, structured) gets the dispatch server in its Claude config, carrying caller identity', () => {
    const configPath = path.join(tmpDir, 'mcp-claude-coord.json');
    const { svc } = makeService(configPath);
    const manager = new CapturingClaudeManager();
    svc.setStructuredManager(manager);

    const terminal = svc.createTerminal('s1', 'claude-code', 'Overseer', false, undefined, undefined, {
      transport: 'structured',
      role: 'coordinator',
    });

    expect(manager.calls).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(written.mcpServers.dispatch).toBeTruthy();
    expect(written.mcpServers.dispatch.command).toBe('node');
    expect(written.mcpServers.dispatch.env.DISPATCH_TERMINAL).toBe(terminal.id);
    expect(written.mcpServers.dispatch.env.DISPATCH_SESSION).toBe('s1');
  });

  it('a coordinator (codex, structured) rides the SAME standard path — codexArgs carry the dispatch server', () => {
    const configPath = path.join(tmpDir, 'mcp-codex-coord.json');
    const { svc } = makeService(configPath);
    const manager = new CapturingCodexManager();
    svc.setCodexStructuredManager(manager);

    svc.createTerminal('s1', 'codex', 'Overseer', false, undefined, undefined, {
      transport: 'structured',
      role: 'coordinator',
    });

    expect(manager.calls).toHaveLength(1);
    const args = manager.calls[0].args;
    expect(args).toContain('mcp_servers.dispatch.command="node"');
  });

  it('a non-coordinator (plain agent) thread gets NO dispatch server — the gate still holds', () => {
    const configPath = path.join(tmpDir, 'mcp-non-coord.json');
    const { svc } = makeService(configPath);
    const manager = new CapturingClaudeManager();
    svc.setStructuredManager(manager);

    svc.createTerminal('s1', 'claude-code', 'Implementer', false, undefined, undefined, {
      transport: 'structured',
      role: 'agent',
    });

    expect(manager.calls).toHaveLength(1);
    // No MCP specs at all are wired in this harness (no doppler/integrations), so with
    // the gate holding, no config file should even be written.
    if (fs.existsSync(configPath)) {
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(written.mcpServers?.dispatch).toBeUndefined();
    }
  });

  it('a coordinator on the PTY (non-structured) spawn path also gets caller identity', () => {
    const configPath = path.join(tmpDir, 'mcp-pty-coord.json');
    const { svc, pty } = makeService(configPath);

    // externalId set -> resume path -> skips best-effort async session-id capture.
    const terminal = svc.createTerminal('s1', 'claude-code', 'Overseer', false, undefined, 'ext-coord', {
      role: 'coordinator',
    });

    expect(pty.calls.find((c) => c.command === 'claude')).toBeTruthy();
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(written.mcpServers.dispatch).toBeTruthy();
    expect(written.mcpServers.dispatch.env.DISPATCH_TERMINAL).toBe(terminal.id);
    expect(written.mcpServers.dispatch.env.DISPATCH_SESSION).toBe('s1');
  });

  it('a coordinator (codex) never gets the config-file treatment: no stray coordinator-<id>.mcp.json is written', () => {
    const configPath = path.join(tmpDir, 'mcp-no-stray.json');
    const { svc } = makeService(configPath);
    const manager = new CapturingClaudeManager();
    svc.setStructuredManager(manager);

    svc.createTerminal('s1', 'claude-code', 'Overseer', false, undefined, undefined, {
      transport: 'structured',
      role: 'coordinator',
    });

    const stray = fs.readdirSync(tmpDir).filter((f) => f.startsWith('coordinator-'));
    expect(stray).toEqual([]);
  });
});
