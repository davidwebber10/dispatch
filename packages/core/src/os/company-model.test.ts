import { describe, expect, test, vi } from 'vitest';
import {
  checkClaudeModelSwitch, companyClaudeEnv, companyModelId, decideClaudeSource, defaultCompanyClaude, isCompanyClaudeThread,
  isGrantedCompanyClaude, parseModelAccess, parseModelProxy, MODEL_NOT_AVAILABLE, SUBSCRIPTION_NOT_ALLOWED, COMPANY_MODEL_FIXED, START_NEW_FOR_COMPANY,
} from './company-model.js';
import { OsConnectionsProvider } from '../integrations/os-provider.js';
import { claudeLoginEnv, companyDisallowedTools, COMPANY_MODEL_NO_RELAY } from '../sessions/thread-spawner.js';
import { listChats } from '../routes/chats.js';

const RAW = {
  models: ['claude-opus-5-5'], default: 'claude-opus-5-5', subscriptionsAllowed: false,
  subscriptions: { claude: false, codex: false }, harnesses: ['claude-code'], seatFirst: true,
  modelHarness: { 'claude-opus-5-5': 'claude-code', 'gpt-6.1-sol': 'codex' },
};
const access = (patch: Record<string, unknown> = {}) => parseModelAccess({ ...RAW, ...patch })!;

describe('parse', () => {
  test('modelAccess in the contract shape; absent or not an object is null', () => {
    expect(access()).toEqual({ ...RAW, subscriptions: { claude: false, codex: false } });
    expect(parseModelAccess(undefined)).toBeNull();
    expect(parseModelAccess(null)).toBeNull();
    expect(parseModelAccess([1])).toBeNull();
    expect(parseModelAccess({ models: 'x' })!.models).toEqual([]);
  });
  test('modelProxy keeps http(s) addresses only; null and empty are null', () => {
    expect(parseModelProxy({ anthropicBaseUrl: 'https://os.example/api/dispatch/model/anthropic/', openaiBaseUrl: 'ftp://x', usageUrl: null }))
      .toEqual({ anthropicBaseUrl: 'https://os.example/api/dispatch/model/anthropic', openaiBaseUrl: null, usageUrl: null });
    expect(parseModelProxy(null)).toBeNull();
    expect(parseModelProxy({})).toBeNull();
  });
  test('the provider keeps both fields, shows modelAccess (not the proxy) to the page, and an answer without them changes nothing', async () => {
    let body: Record<string, unknown> = { servers: [], profile: 'business', modelAccess: RAW, modelProxy: { anthropicBaseUrl: 'https://os.example/a' } };
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
    const p = new OsConnectionsProvider({ baseUrl: 'https://os.example', boxToken: 'b', fetchImpl: fetchImpl as any });
    await p.refresh();
    expect(p.modelAccess()?.models).toEqual(['claude-opus-5-5']);
    expect(p.modelProxy()?.anthropicBaseUrl).toBe('https://os.example/a');
    expect(p.publicSnapshot().modelAccess?.default).toBe('claude-opus-5-5');
    expect(JSON.stringify(p.publicSnapshot())).not.toContain('os.example/a');
    body = { servers: [], profile: 'business' };
    await p.refresh();
    expect(p.modelAccess()).toBeNull();
    expect(p.modelProxy()).toBeNull();
    expect(new OsConnectionsProvider({}).modelAccess()).toBeNull();
  });
});

describe('which model is a company Claude model', () => {
  test('the id, any case, or without claude-; granted only in models with harness claude-code', () => {
    const a = access();
    expect(companyModelId(a, 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(companyModelId(a, 'Claude-Opus-5-5')).toBe('claude-opus-5-5');
    expect(companyModelId(a, 'opus-5-5')).toBe('claude-opus-5-5');
    expect(companyModelId(a, 'opus')).toBeNull();
    expect(isGrantedCompanyClaude(a, 'claude-opus-5-5')).toBe(true);
    expect(isGrantedCompanyClaude(a, 'gpt-6.1-sol')).toBe(false);
    expect(isGrantedCompanyClaude(null, 'claude-opus-5-5')).toBe(false);
  });
  test('without modelHarness an id that starts with claude- is a Claude model', () => {
    const a = access({ modelHarness: undefined, models: ['claude-opus-5-5', 'gpt-x'] });
    expect(isGrantedCompanyClaude(a, 'claude-opus-5-5')).toBe(true);
    expect(isGrantedCompanyClaude(a, 'gpt-x')).toBe(false);
    expect(defaultCompanyClaude(access({ default: 'gpt-6.1-sol', models: ['gpt-6.1-sol', 'claude-opus-5-5'] }))).toBe('claude-opus-5-5');
  });
});

describe('a new Claude Code thread', () => {
  test('no modelAccess: today (company is refused, any other modelSource is dropped)', () => {
    expect(decideClaudeSource(null, { model: 'claude-opus-5-5' }, false)).toEqual({ ok: true, patch: null, strip: false });
    expect(decideClaudeSource(null, { modelSource: 'subscription' }, true)).toEqual({ ok: true, patch: null, strip: true });
    expect(decideClaudeSource(null, { modelSource: 'company' }, true)).toEqual({ ok: false, status: 403, message: MODEL_NOT_AVAILABLE });
  });
  test('no personal login, or subscriptions.claude false: the company model', () => {
    expect(decideClaudeSource(access(), { model: 'claude-opus-5-5' }, true)).toEqual({ ok: true, patch: { model: 'claude-opus-5-5', modelSource: 'company' } });
    expect(decideClaudeSource(access({ subscriptions: { claude: true } }), { model: 'opus-5-5' }, false)).toEqual({ ok: true, patch: { model: 'claude-opus-5-5', modelSource: 'company' } });
  });
  test('no model named and no personal login: the company default', () => {
    expect(decideClaudeSource(access(), {}, false)).toEqual({ ok: true, patch: { model: 'claude-opus-5-5', modelSource: 'company' } });
  });
  test('seatFirst and an allowed personal login: the personal login, unless company is asked for', () => {
    const a = access({ subscriptions: { claude: true } });
    expect(decideClaudeSource(a, { model: 'claude-opus-5-5' }, true)).toEqual({ ok: true, patch: { modelSource: 'subscription' } });
    expect(decideClaudeSource(a, { model: 'claude-opus-5-5', modelSource: 'company' }, true)).toEqual({ ok: true, patch: { model: 'claude-opus-5-5', modelSource: 'company' } });
    expect(decideClaudeSource(a, {}, true)).toEqual({ ok: true, patch: null, strip: false });
    expect(decideClaudeSource(access({ subscriptions: { claude: true }, seatFirst: false }), { model: 'claude-opus-5-5' }, true))
      .toEqual({ ok: true, patch: { model: 'claude-opus-5-5', modelSource: 'company' } });
  });
  test('subscription forced: allowed only when the platform allows the personal login', () => {
    expect(decideClaudeSource(access(), { modelSource: 'subscription' }, true)).toEqual({ ok: false, status: 403, message: SUBSCRIPTION_NOT_ALLOWED });
    expect(decideClaudeSource(access({ subscriptions: { claude: true } }), { modelSource: 'subscription', model: 'claude-opus-5-5' }, false))
      .toEqual({ ok: true, patch: { modelSource: 'subscription' } });
  });
  test('a company model not granted is refused when it would run on the company model', () => {
    const a = access({ models: [] });
    expect(decideClaudeSource(a, { model: 'claude-opus-5-5' }, false)).toEqual({ ok: false, status: 403, message: MODEL_NOT_AVAILABLE });
    expect(decideClaudeSource(a, { model: 'claude-opus-5-5', modelSource: 'company' }, true)).toEqual({ ok: false, status: 403, message: MODEL_NOT_AVAILABLE });
    expect(decideClaudeSource(access(), { model: 'gpt-6.1-sol', modelSource: 'company' }, true)).toEqual({ ok: false, status: 403, message: MODEL_NOT_AVAILABLE });
    // A model the platform does not name: the person's own login, as today.
    expect(decideClaudeSource(access(), { model: 'sonnet' }, false)).toEqual({ ok: true, patch: null, strip: false });
  });
});

describe('a model switch', () => {
  test('a company thread keeps its model; a revoked or other model is refused', () => {
    const cfg = { model: 'claude-opus-5-5', modelSource: 'company' };
    expect(checkClaudeModelSwitch(access(), cfg, 'claude-opus-5-5', false)).toBeNull();
    expect(checkClaudeModelSwitch(access(), cfg, 'sonnet', false)).toEqual({ status: 403, message: MODEL_NOT_AVAILABLE });
    expect(checkClaudeModelSwitch(access({ models: ['claude-opus-5-5', 'claude-x'], modelHarness: { 'claude-opus-5-5': 'claude-code', 'claude-x': 'claude-code' } }), cfg, 'claude-x', false))
      .toEqual({ status: 409, message: COMPANY_MODEL_FIXED });
    expect(checkClaudeModelSwitch(null, cfg, 'claude-opus-5-5', false)).toEqual({ status: 403, message: MODEL_NOT_AVAILABLE });
  });
  test('a personal thread: today, unless the target is a company model', () => {
    expect(checkClaudeModelSwitch(null, {}, 'claude-opus-5-5', true)).toBeNull();
    expect(checkClaudeModelSwitch(access(), {}, 'sonnet', true)).toBeNull();
    expect(checkClaudeModelSwitch(access({ models: [] }), {}, 'claude-opus-5-5', true)).toEqual({ status: 403, message: MODEL_NOT_AVAILABLE });
    expect(checkClaudeModelSwitch(access(), {}, 'claude-opus-5-5', false)).toEqual({ status: 409, message: START_NEW_FOR_COMPANY });
    expect(checkClaudeModelSwitch(access({ subscriptions: { claude: true } }), {}, 'claude-opus-5-5', true)).toBeNull();
  });
});

describe('the env of a company thread', () => {
  test('the relay, the thread key, every model pinned; no login competes', () => {
    const env = companyClaudeEnv('http://127.0.0.1:3456/base/', 'dtk_k', 'claude-opus-5-5');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3456/base/api/os-model/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('dtk_k');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(env.ANTHROPIC_API_KEY).toBe('');
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
      expect(env[k], k).toBe('claude-opus-5-5');
    }
    expect(env.CLAUDE_CODE_DISABLE_FAST_MODE).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(Object.values(env).join(' ')).not.toMatch(/box/i);
  });
  test('claudeLoginEnv: the account overlay for every other thread; the relay (no CLAUDE_CONFIG_DIR) for a company thread', () => {
    const acct = { CLAUDE_CONFIG_DIR: '/acct', CLAUDE_CODE_OAUTH_TOKEN: '', DOPPLER_TOKEN: 'x' };
    expect(claudeLoginEnv('claude-code', { model: 'claude-opus-5-5' }, acct, { daemonApi: 'http://127.0.0.1:1', key: 'dtk_k' })).toBe(acct);
    expect(claudeLoginEnv('codex', { model: 'claude-opus-5-5', modelSource: 'company' }, acct, { daemonApi: 'http://127.0.0.1:1', key: 'dtk_k' })).toBe(acct);
    const env = claudeLoginEnv('claude-code', { model: 'claude-opus-5-5', modelSource: 'company' }, acct, { daemonApi: 'http://127.0.0.1:1', key: 'dtk_k' });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.DOPPLER_TOKEN).toBe('x');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('dtk_k');
    expect(() => claudeLoginEnv('claude-code', { model: 'claude-opus-5-5', modelSource: 'company' }, acct, { daemonApi: null, key: 'dtk_k' })).toThrow(COMPANY_MODEL_NO_RELAY);
    expect(() => claudeLoginEnv('claude-code', { model: 'claude-opus-5-5', modelSource: 'company' }, acct, { daemonApi: 'http://x', key: null })).toThrow(COMPANY_MODEL_NO_RELAY);
  });
  test('no web search on a company thread; other threads unchanged', () => {
    expect(companyDisallowedTools('claude-code', { model: 'm', modelSource: 'company' }, ['Agent'])).toEqual(['Agent', 'WebSearch']);
    expect(companyDisallowedTools('claude-code', { model: 'm' }, undefined)).toBeUndefined();
    expect(isCompanyClaudeThread('claude-code', { modelSource: 'company' })).toBe(false); // no model: not a company thread
  });
});

describe('GET /api/chats', () => {
  test('modelSource is reported, null for a thread without it', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (id TEXT, name TEXT, archived_at TEXT);
      CREATE TABLE terminals (id TEXT, session_id TEXT, label TEXT, type TEXT, status TEXT, config TEXT, created_at TEXT, last_activity_at TEXT, archived_at TEXT);
      INSERT INTO sessions VALUES ('s', 'Chats', NULL);
      INSERT INTO terminals VALUES ('a', 's', 'A', 'claude-code', 'idle', '{"transport":"structured","model":"claude-opus-5-5","modelSource":"company"}', '2026-11-12T00:00:00Z', NULL, NULL);
      INSERT INTO terminals VALUES ('b', 's', 'B', 'claude-code', 'idle', '{"transport":"structured"}', '2026-11-11T00:00:00Z', NULL, NULL);`);
    const chats = listChats(db);
    expect(chats.map((c) => [c.id, c.modelSource])).toEqual([['a', 'company'], ['b', null]]);
  });
});
