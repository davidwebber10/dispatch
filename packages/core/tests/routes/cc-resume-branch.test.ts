import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createApp } from '../../src/server.js';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { claudeCodeProvider } from '../../src/providers/claude-code.js';
import { codexProvider } from '../../src/providers/codex.js';
import { grokProvider } from '../../src/providers/grok.js';

describe('claude-code buildBranchCommand', () => {
  it('resumes the source id and forks it', () => {
    const cmd = claudeCodeProvider.buildBranchCommand!({ sourceSessionId: 'abc-123', workDir: '/tmp/x' });
    expect(cmd.command).toBe('claude');
    expect(cmd.args).toContain('-r');
    expect(cmd.args).toContain('abc-123');
    expect(cmd.args).toContain('--fork-session');
    // -r must be immediately followed by the source id
    expect(cmd.args[cmd.args.indexOf('-r') + 1]).toBe('abc-123');
  });
});

describe('codex buildBranchCommand', () => {
  it('forks the source id with the same autonomy flags as resume, ahead of the subcommand', () => {
    const cmd = codexProvider.buildBranchCommand!({ sourceSessionId: 'abc-123', workDir: '/tmp/x' });
    expect(cmd.command).toBe('codex');
    const fork = cmd.args.indexOf('fork');
    expect(cmd.args.slice(fork)).toEqual(['fork', 'abc-123']);
    expect(cmd.args.indexOf('--dangerously-bypass-approvals-and-sandbox')).toBeLessThan(fork);
  });
});

describe('grok buildBranchCommand', () => {
  it('resumes the source with --fork-session and names the fork with the assigned id', () => {
    const cmd = grokProvider.buildBranchCommand!({ sourceSessionId: 'abc-123', workDir: '/tmp/x', sessionId: 'new-id' });
    expect(cmd.command).toBe('grok');
    expect(cmd.args[cmd.args.indexOf('--resume') + 1]).toBe('abc-123');
    expect(cmd.args).toContain('--fork-session');
    expect(cmd.args[cmd.args.indexOf('--session-id') + 1]).toBe('new-id');
  });
});

describe('resume + branch routes', () => {
  let app: any; let db: Database.Database; let sessionId: string; let tmpDir: string;

  beforeEach(async () => {
    db = new Database(':memory:'); initSchema(db);
    app = createApp({ db, skipPty: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ccrb-'));
    const res = await request(app).post('/api/sessions').send({ provider: 'claude-code', workingDir: tmpDir, name: 'test' });
    sessionId = res.body.id;
  });

  it('GET /cc-recent returns [] when the project has no transcripts', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}/cc-recent`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST /branch 422s when the source thread has no session id yet', async () => {
    terminalsDb.create(db, { id: 'src-1', sessionId, type: 'claude-code', label: 'Claude Code', skipPermissions: false, workingDir: tmpDir });
    const res = await request(app).post('/api/terminals/src-1/branch');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/no session/i);
  });

  it('POST /branch 400s for an unknown thread', async () => {
    const res = await request(app).post('/api/terminals/nope/branch');
    expect(res.status).toBe(400);
  });

  it('POST /reset-status sets a stuck thread back to idle (waiting), 404s for an unknown one', async () => {
    terminalsDb.create(db, { id: 'stuck', sessionId, type: 'claude-code', label: 'Claude Code', skipPermissions: false, workingDir: tmpDir });
    terminalsDb.updateStatus(db, 'stuck', 'needs_input');
    const ok = await request(app).post('/api/terminals/stuck/reset-status');
    expect(ok.status).toBe(204);
    expect(terminalsDb.getById(db, 'stuck')!.status).toBe('waiting');
    expect((await request(app).post('/api/terminals/nope/reset-status')).status).toBe(404);
  });
});
