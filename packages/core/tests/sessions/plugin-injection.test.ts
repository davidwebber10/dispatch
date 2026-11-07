import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';

class CapturingPty extends PTYManager {
  public calls: { id: string; command: string; args: string[] }[] = [];
  private pid = 1;
  override spawn(id: string, command: string, args: string[]): number { this.calls.push({ id, command, args }); return this.pid++; }
  override write(): void {}
  override resize(): void {}
  override kill(): void {}
  override getBuffer(): string { return ''; }
  override isAlive(): boolean { return false; }
  override killAll(): void {}
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-plugin-inj-'));
const configPath = path.join(tmpDir, 'mcp.json');
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: tmpDir });
  const pty = new CapturingPty();
  const svc = new SessionService(db, pty, configPath);
  svc.setIntegrationsSpecs(() => [{ name: 'fs', command: 'npx', args: ['-y', 'server-fs'] }]);
  svc.setPluginInjection((harness, sessionId) => (harness === 'claude-code'
    ? { specs: [{ name: 'plugin-coach', command: 'node', args: ['/plugins/coach/mcp/server.js'], env: { DISPATCH_PLUGIN: 'coach' }, authEnv: true }], prompts: ['## Plugin: Coach\n\nRun the tests before you report done.', ...(sessionId === 's1' ? ['## Skill: Review\n\nFolder: /skills/review\n\nRead the diff twice.'] : [])], toolNames: ['plugin-coach'] }
    : { specs: [], prompts: [], toolNames: [] }));
  return { svc, pty };
}

/** Plugins reach every thread's launch (docs/superpowers/specs/2026-11-07-plugins-design.md, section 3). */
describe('plugin injection at spawn (2026-11-07)', () => {
  it('a Claude CLI spawn writes the plugin server into thread-<id>.mcp.json, the instructions into the system prompt, and config.toolsAvailable names every server', () => {
    const { svc, pty } = makeService();
    const terminal = svc.createTerminal('s1', 'claude-code', 'CC', true, undefined, 'ext-claude');
    const call = pty.calls.find((c) => c.command === 'claude')!;
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, `thread-${terminal.id}.mcp.json`), 'utf8'));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['dispatch', 'fs', 'plugin-coach']);
    expect(cfg.mcpServers['plugin-coach'].env).toMatchObject({ DISPATCH_PLUGIN: 'coach', DISPATCH_AUTH: '${DISPATCH_AUTH}' });
    const i = call.args.findIndex((a) => a === '--append-system-prompt' || a === '--append-system-prompt-file');
    expect(i).toBeGreaterThanOrEqual(0);
    const prompt = call.args[i] === '--append-system-prompt' ? call.args[i + 1] : fs.readFileSync(call.args[i + 1], 'utf8');
    expect(prompt).toContain('## Plugin: Coach');
    expect(prompt.indexOf('Peer tools')).toBeLessThan(prompt.indexOf('## Plugin: Coach'));
    const row = svc.getTerminal(terminal.id)!;
    expect((row.config as { toolsAvailable?: string[] }).toolsAvailable).toEqual(['fs', 'dispatch', 'plugin-coach']);
  });

  it("a plugin server's env carries the daemon's address and port, so a harness that passes only listed variables (Codex) still reaches the daemon", () => {
    const { svc } = makeService();
    svc.setDaemonApi('http://127.0.0.1:4321/');
    svc.setDaemonPort(4321);
    const terminal = svc.createTerminal('s1', 'claude-code', 'CC', true, undefined, 'ext-claude-2');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, `thread-${terminal.id}.mcp.json`), 'utf8'));
    expect(cfg.mcpServers['plugin-coach'].env).toMatchObject({ DISPATCH_API: 'http://127.0.0.1:4321', DISPATCH_PORT: '4321', DISPATCH_PLUGIN: 'coach' });
  });

  it("the injection hears the thread's project, so a project's skills reach its spawn and not another's", () => {
    const { svc, pty } = makeService();
    const terminal = svc.createTerminal('s1', 'claude-code', 'CC', true, undefined, 'ext-claude-3');
    const call = pty.calls.find((c) => c.command === 'claude')!;
    const i = call.args.findIndex((a) => a === '--append-system-prompt' || a === '--append-system-prompt-file');
    const prompt = call.args[i] === '--append-system-prompt' ? call.args[i + 1] : fs.readFileSync(call.args[i + 1], 'utf8');
    expect(prompt).toContain('## Skill: Review');
    expect(prompt.indexOf('## Plugin: Coach')).toBeLessThan(prompt.indexOf('## Skill: Review'));
    expect(terminal.id).toBeTruthy();
  });

  it('a harness the plugin does not list gets nothing from it', () => {
    const { svc, pty } = makeService();
    const terminal = svc.createTerminal('s1', 'codex', 'CX', true, undefined, 'ext-codex');
    const call = pty.calls.find((c) => c.command === 'codex')!;
    expect(call.args.some((a) => a.includes('plugin-coach'))).toBe(false);
    expect((svc.getTerminal(terminal.id)!.config as { toolsAvailable?: string[] }).toolsAvailable).toEqual(['fs', 'dispatch']);
  });
});
