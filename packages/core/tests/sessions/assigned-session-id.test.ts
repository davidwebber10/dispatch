import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';

/** Records the argv each spawn was given, and can refuse to start like a real failure. */
class CapturingPty extends PTYManager {
  calls: { id: string; command: string; args: string[]; env?: Record<string, string> }[] = [];
  failNext = false;
  private pid = 1;
  override spawn(id: string, command: string, args: string[], _workDir: string, env?: Record<string, string>): number {
    if (this.failNext) throw new Error('spawn failed');
    this.calls.push({ id, command, args, env });
    return this.pid++;
  }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-assigned-sid-'));
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: tmpDir });
  const pty = new CapturingPty();
  const svc = new SessionService(db, pty, path.join(tmpDir, 'mcp.json'));
  return { svc, pty, db };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Grok names its own session. Without this a Grok thread that outlived a daemon restart had
 * no external id to resume into, so it silently started a brand-new conversation.
 */
describe('a provider that assigns its own session id', () => {
  it('generates a uuid, passes it to the CLI, and stores it as the external id', () => {
    const { svc, pty, db } = makeService();
    const terminal = svc.createTerminal('s1', 'grok', 'Grok');

    const spawned = pty.calls.find((c) => c.id === terminal.id)!;
    const i = spawned.args.indexOf('--session-id');
    expect(i).toBeGreaterThan(-1);

    const passed = spawned.args[i + 1];
    expect(passed).toMatch(UUID);
    // The id the CLI was told to use is exactly the one we can resume with later.
    expect(terminalsDb.getById(db, terminal.id)?.external_id).toBe(passed);
  });

  it('resumes into that same conversation on a relaunch', async () => {
    const { svc, pty, db } = makeService();
    const terminal = svc.createTerminal('s1', 'grok', 'Grok');
    const assigned = terminalsDb.getById(db, terminal.id)!.external_id!;

    pty.calls.length = 0;
    await svc.restartTerminal(terminal.id);

    const relaunch = pty.calls.find((c) => c.id === terminal.id)!;
    expect(relaunch.args).toContain('--resume');
    expect(relaunch.args[relaunch.args.indexOf('--resume') + 1]).toBe(assigned);
    // `--session-id` on a resume would fork rather than resume.
    expect(relaunch.args).not.toContain('--session-id');
  });

  it('gives each thread its own id', () => {
    const { svc, db } = makeService();
    const a = svc.createTerminal('s1', 'grok', 'Grok');
    const b = svc.createTerminal('s1', 'grok', 'Grok');
    const idA = terminalsDb.getById(db, a.id)?.external_id;
    const idB = terminalsDb.getById(db, b.id)?.external_id;
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });

  it('stores nothing when the spawn fails', () => {
    // A stored id for a process that never started would send the next relaunch chasing a
    // conversation that does not exist.
    const { svc, pty, db } = makeService();
    pty.failNext = true;
    let terminalId: string | null = null;
    try {
      terminalId = svc.createTerminal('s1', 'grok', 'Grok').id;
    } catch {
      // createTerminal may surface the spawn failure; either way nothing must be stored.
    }
    if (terminalId) expect(terminalsDb.getById(db, terminalId)?.external_id).toBeFalsy();
  });

  it('leaves providers that discover their id alone', () => {
    const { svc, pty, db } = makeService();
    const terminal = svc.createTerminal('s1', 'claude-code', 'Claude');
    const spawned = pty.calls.find((c) => c.id === terminal.id)!;
    expect(spawned.args).not.toContain('--session-id');
    // Claude's id arrives later, from captureSessionId — not at spawn time.
    expect(terminalsDb.getById(db, terminal.id)?.external_id).toBeFalsy();
  });

  it('does not touch a plain shell', () => {
    const { svc, pty } = makeService();
    const terminal = svc.createTerminal('s1', 'shell', 'Shell');
    const spawned = pty.calls.find((c) => c.id === terminal.id)!;
    expect(spawned.args).not.toContain('--session-id');
  });
});

/**
 * Every harness should be driven the same way. Grok was silently excluded from the peer
 * tools, so a Grok thread could not spawn agents, message threads, or report_status — which
 * would have undercut the status hooks it just gained.
 */
describe('a grok thread is wired like the others', () => {
  function withStatus() {
    const made = makeService();
    made.svc.setStatusContext({
      serverUrl: 'http://127.0.0.1:3456',
      hooksDir: path.join(tmpDir, 'hooks'),
      codexHelperPath: '/opt/codex-notify.mjs',
      grokHelperPath: '/opt/grok-hook.mjs',
    });
    return made;
  }

  it('gets the agency peer server, like claude-code and codex do', () => {
    const { svc } = withStatus();
    const terminal = svc.createTerminal('s1', 'grok', 'Grok');
    const mcp = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'hooks', 'grok-homes', terminal.id, 'plugins', 'dispatch', '.mcp.json'), 'utf-8'),
    ) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers)).toContain('dispatch');
  });

  it('is told about them — the plugin dir registers the tools, --rules explains them', () => {
    const { svc, pty } = withStatus();
    const terminal = svc.createTerminal('s1', 'grok', 'Grok');
    const spawned = pty.calls.find((c) => c.id === terminal.id)!;
    // Hooks and MCP arrive via GROK_HOME, never argv — --plugin-dir is a startup error on
    // the top-level command.
    expect(spawned.args).not.toContain('--plugin-dir');
    expect(spawned.env?.GROK_HOME).toBeTruthy();
    expect(spawned.args).toContain('--rules');
  });

  it('gets its status hooks written alongside them', () => {
    const { svc } = withStatus();
    const terminal = svc.createTerminal('s1', 'grok', 'Grok');
    const hooks = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'hooks', 'grok-homes', terminal.id, 'plugins', 'dispatch', 'hooks', 'hooks.json'), 'utf-8'),
    ) as { hooks: Record<string, unknown> };
    expect(hooks.hooks.Stop).toBeTruthy();
  });
});
