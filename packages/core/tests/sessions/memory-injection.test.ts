import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { SessionService } from '../../src/sessions/service.js';
import { PTYManager } from '../../src/pty/manager.js';
import { MemoryService, projectsFromDb } from '../../src/memory/service.js';
import { updateMemorySettings } from '../../src/memory/settings.js';

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-memory-inj-'));
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

/** The block reaches both harnesses at spawn (spec 2026-11-17-memory-design.md, section 4.3), wired as in daemon/build.ts. */
function makeService() {
  const db = new Database(':memory:');
  initSchema(db);
  for (const id of ['s1', 's2']) sessionsDb.create(db, { id, provider: 'claude-code', name: id, workingDir: tmpDir });
  const memory = new MemoryService({ db, projects: () => projectsFromDb(db) });
  updateMemorySettings(db, { enabled: true }); // off by default
  memory.createPage({ scope: 'project:s1', slug: 'deploy', description: 'How s1 deploys', pinned: true });
  memory.createPage({ scope: 'project:s2', slug: 'other', description: 'Only for s2', pinned: true });
  memory.createPage({ scope: 'you', slug: 'how-i-work', description: 'Short replies', pinned: true });
  memory.addUserNote({ scope: 'you', text: 'Replies are short.' });
  const pty = new CapturingPty();
  const svc = new SessionService(db, pty, path.join(tmpDir, 'mcp.json'));
  // As daemon/build.ts: the block, and the memory tools only while memory is on.
  svc.setPluginInjection((harness, sessionId) => ({ specs: [], prompts: memory.injection(sessionId, harness), toolNames: [], memoryTools: memory.available() }));
  return { db, svc, pty, memory };
}

const claudePrompt = (args: string[]): string => {
  const i = args.findIndex((a) => a === '--append-system-prompt' || a === '--append-system-prompt-file');
  return args[i] === '--append-system-prompt' ? args[i + 1] : fs.readFileSync(args[i + 1], 'utf8');
};
const codexInstructions = (args: string[]): string => {
  const a = args.find((x) => x.startsWith('developer_instructions='))!;
  return JSON.parse(a.slice('developer_instructions='.length));
};

describe('the memory block at spawn', () => {
  it('a Claude Code terminal thread gets its project and You, not another project', () => {
    const { svc, pty } = makeService();
    svc.createTerminal('s1', 'claude-code', 'CC', true, undefined, 'ext-1');
    const prompt = claudePrompt(pty.calls.find((c) => c.command === 'claude')!.args);
    expect(prompt).toContain('## Memory');
    expect(prompt).toContain('- deploy: How s1 deploys');
    expect(prompt).toContain('- how-i-work: Short replies (you)');
    expect(prompt).not.toContain('Replies are short.'); // notes are found with memory_search, not injected
    expect(prompt).not.toContain('Only for s2');
  });

  it('a Codex terminal thread gets the same block in its developer instructions', () => {
    const { svc, pty } = makeService();
    svc.createTerminal('s1', 'codex', 'CX', true, undefined, 'ext-2');
    const text = codexInstructions(pty.calls.find((c) => c.command === 'codex')!.args);
    expect(text).toContain('## Memory');
    expect(text).toContain('- deploy: How s1 deploys');
  });

  it('memory off (the default): no block and no memory tools; on: both, for the next spawn', () => {
    const { db, svc, pty } = makeService();
    updateMemorySettings(db, { enabled: null }); // back to the default
    svc.createTerminal('s1', 'claude-code', 'CC', true, undefined, 'ext-3');
    const off = pty.calls.find((c) => c.command === 'claude')!.args;
    expect(claudePrompt(off)).not.toContain('## Memory');
    expect(claudePrompt(off)).not.toContain('memory_search');
    const offCfg = fs.readFileSync(off[off.indexOf('--mcp-config') + 1], 'utf8');
    expect(offCfg).not.toContain('DISPATCH_MEMORY');
    updateMemorySettings(db, { enabled: true });
    svc.createTerminal('s1', 'codex', 'CX', true, undefined, 'ext-4');
    const on = pty.calls.find((c) => c.command === 'codex')!.args;
    expect(codexInstructions(on)).toContain('## Memory');
  });
});
