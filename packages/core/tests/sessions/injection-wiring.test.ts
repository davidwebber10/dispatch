import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import type { McpServerSpec } from '../../src/mcp/injection.js';

// Captures the argv handed to the PTY; all other PTY ops are safe no-ops.
class CapturingPty extends PTYManager {
  public calls: { id: string; command: string; args: string[] }[] = [];
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

const dopplerSpec: McpServerSpec = { name: 'doppler', command: 'node', args: ['/x/doppler-server.js'], envVars: ['DOPPLER_TOKEN', 'DOPPLER_PROJECT'] };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-inj-'));
const configPath = path.join(tmpDir, 'mcp.json');
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ } });

function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 't', workingDir: tmpDir });
  const pty = new CapturingPty();
  const svc = new SessionService(db, pty, configPath);
  svc.setSecretsServerSpec(() => ({ spec: dopplerSpec, prompt: 'Use Doppler for secrets.' }));
  svc.setIntegrationsSpecs(() => [
    { name: 'fs', command: 'npx', args: ['-y', 'server-fs'] },
    { name: 'linear', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.linear.app/sse'] },
  ]);
  return { svc, pty };
}

describe('spawn-time MCP injection wiring', () => {
  it('merges Doppler + catalog specs into the Claude argv (--mcp-config)', () => {
    const { svc, pty } = makeService();
    // externalId -> resume path -> skips best-effort async session-id capture
    svc.createTerminal('s1', 'claude-code', 'CC', true, undefined, 'ext-claude');
    const call = pty.calls.find(c => c.command === 'claude');
    expect(call).toBeTruthy();
    const args = call!.args;
    const i = args.indexOf('--mcp-config');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(configPath);
    expect(args).toContain('--append-system-prompt');
    // Both servers present in the written config file
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(Object.keys(written.mcpServers).sort()).toEqual(['doppler', 'fs', 'linear']);
  });

  it('merges Doppler + catalog specs into the Codex argv (-c mcp_servers.* for all servers)', () => {
    const { svc, pty } = makeService();
    svc.createTerminal('s1', 'codex', 'CX', true, undefined, 'ext-codex');
    const call = pty.calls.find(c => c.command === 'codex');
    expect(call).toBeTruthy();
    const args = call!.args;
    expect(args).toContain('mcp_servers.doppler.command="node"');
    expect(args).toContain('mcp_servers.fs.command="npx"');
    expect(args).toContain('mcp_servers.linear.command="npx"');
  });
});
