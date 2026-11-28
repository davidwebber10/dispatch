// Chat's own account (owner, 2026-11-27): "Default account" follows Settings; a named account applies
// from the next message; the figures and the memory compactions follow the same account.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { EndlessService, type EndlessServiceOptions } from '../../src/endless/service.js';
import { createEndlessRouter } from '../../src/routes/endless.js';
import { AccountsStore } from '../../src/auth/accounts.js';
import { claudeLoginSources } from '../../src/auth/claude-login-sources.js';
import { wireLimits, type LimitInputs } from '../../src/daemon/wire-limits.js';
import { FakeSummarizer, settle } from './fake-summarizer.js';
import { FakeManager } from './fake-manager.js';

let root: string;
let db: Database.Database;
let accounts: AccountsStore;
let team: string;
let fake: FakeManager;
let svc: EndlessService;
let app: express.Express;
let events: Record<string, unknown>[];

function make(over: Partial<EndlessServiceOptions> = {}): EndlessService {
  const logins = claudeLoginSources(accounts, () => ({}));
  const s = new EndlessService({
    db, broadcaster: { broadcast: (e) => events.push(e) }, manager: fake.asManager(),
    chatDir: path.join(root, 'chat'), home: path.join(root, 'home'), summarizer: new FakeSummarizer(), timeZone: 'UTC', turn: { waitMs: 50, graceMs: 10 },
    claudeLoginEnv: (id) => logins.overlay(id),
    claudeAccounts: { has: (id) => accounts.has('claude', id), defaultId: () => accounts.defaultId('claude') },
    ...over,
  });
  s.start(3999);
  return s;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-account-'));
  db = new Database(':memory:');
  initSchema(db);
  accounts = new AccountsStore(path.join(root, 'data'));
  team = accounts.addClaude({ token: 'tok-team', label: 'Team' }).id;
  fake = new FakeManager();
  events = [];
  svc = make();
  app = express();
  app.use(express.json());
  app.use('/api/endless', createEndlessRouter(svc));
});
afterEach(() => { svc.stop(); fs.rmSync(root, { recursive: true, force: true }); });

const put = (body: object) => request(app).put('/api/endless/settings').send(body);
const turn = async () => {
  await request(app).post('/api/endless/send').send({ text: 'hello' }).expect(202);
  await settle();
  const spawned = fake.spawned[fake.spawned.length - 1];
  fake.emitEvent({ type: 'result', subtype: 'success', is_error: false });
  await svc.turns.whenIdle();
  return spawned;
};

describe('the account that runs Chat', () => {
  it('starts on the default account, and follows a change of the default', async () => {
    expect((await request(app).get('/api/endless/settings')).body).toMatchObject({ accountId: null });
    expect((await turn()).opts.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe(''); // the CLI login is the default
    accounts.setDefault('claude', team);
    expect((await turn()).opts.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-team');
  });

  it('a named account applies from the next message, whatever the default is, and is announced', async () => {
    await put({ accountId: team }).expect(200);
    expect(events).toContainEqual(expect.objectContaining({ type: 'endless:settings', accountId: team }));
    expect((await turn()).opts.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-team');
    accounts.setDefault('claude', team);
    await put({ accountId: 'cli' }).expect(200);
    expect((await turn()).opts.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    await put({ accountId: null }).expect(200);
    expect((await turn()).opts.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-team');
  });

  it('is kept across a restart of the daemon', async () => {
    await put({ accountId: team }).expect(200);
    svc.stop();
    svc = make();
    expect(svc.chatSettings().accountId).toBe(team);
  });

  it('refuses an account that does not exist, a Codex id included, and a wrong type', async () => {
    const codex = accounts.addCodex('Codex team').id;
    for (const accountId of ['nope', codex, 4]) await put({ accountId }).expect(400);
    expect(svc.chatSettings().accountId).toBeNull();
    expect(events.filter((e) => e.type === 'endless:settings')).toEqual([]);
  });

  it('a removed account falls back to the default account', async () => {
    await put({ accountId: team }).expect(200);
    accounts.remove('claude', team);
    expect(svc.chatSettings().accountId).toBeNull();
    expect((await turn()).opts.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
  });

  it('a change ends a usage-limit pause of Chat; a change of model does not', async () => {
    let ownerActions = 0;
    svc.onOwnerAction = () => { ownerActions += 1; };
    await put({ model: 'haiku' }).expect(200);
    expect(ownerActions).toBe(0);
    await put({ accountId: team }).expect(200);
    await put({ accountId: team }).expect(200); // the same account again is no change
    expect(ownerActions).toBe(1);
  });

  it('remembers the account that each process started on, also after a switch', async () => {
    await put({ accountId: team }).expect(200);
    const first = await turn();
    await put({ accountId: 'cli' }).expect(200);
    const second = await turn();
    expect(svc.accountOfProcess(first.id)).toBe(team);
    expect(svc.accountOfProcess(second.id)).toBe('cli');
    expect(svc.accountOfProcess('unknown')).toBeNull();
  });

  it('a memory compaction runs on the same account as a turn', async () => {
    svc.stop();
    svc = make({ summarizer: undefined });
    svc.setChatSettings({ accountId: team });
    const session = (svc as unknown as { compactor: { d: { summarizer: { open: (o: object) => { close(): void } } } } }).compactor.d.summarizer.open({ systemPrompt: 's', onFirstToken: () => {} });
    const spawned = fake.spawned[fake.spawned.length - 1];
    expect(spawned.id).toMatch(/^endless-compaction-/);
    expect(spawned.opts.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-team');
    expect(svc.accountOfProcess(spawned.id)).toBe(team);
    session.close();
  });
});

describe('the usage figures of a Chat turn', () => {
  it('are filed under the account that the turn ran on, not the default account', () => {
    const endlessManager = new EventEmitter();
    const limits = wireLimits({
      db, env: {}, accounts, network: false, spawnEnv: () => ({}),
      sessionService: {} as never, claudeLogin: {} as never, pushService: {} as never,
      statusService: { addThreadSettledListener: () => {} } as never,
      endless: { accountOfProcess: (id: string) => (id === 'endless-turn-1' ? team : null), turns: { status: 'idle' } } as never,
      endlessManager: endlessManager as never, claudeManager: new EventEmitter() as never,
      broadcaster: { broadcast: () => {} } as never,
    } satisfies Record<keyof Omit<LimitInputs, 'clock'>, unknown> as never);
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    endlessManager.emit('rate-limit', 'endless-turn-1', { rateLimitType: 'five_hour', utilization: 0.4, resetsAt });
    expect(limits.limitSnapshots.get('claude-code', limits.limitAccount('claude-code', team), team)).not.toBeNull();
    expect(limits.limitSnapshots.get('claude-code', limits.limitAccount('claude-code', 'cli'), 'cli')).toBeNull();
  });
});
