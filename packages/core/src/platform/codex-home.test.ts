import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { codexHome, codexSessionsRoot, codexArchivedRoot } from './codex-home.js';
import { locateCodexTranscript } from '../analytics/codex-locate.js';
import { findCodexRolloutPath, codexRolloutTailStatus } from '../sessions/codex-sessions.js';
import { resolveTranscriptPath } from '../sessions/thread-namer.js';
import { codexAccountId } from '../limits/account.js';
import { codexModelsCachePath, pickCodexTitleModel, CODEX_TITLE_MODELS } from '../sessions/cli-namer.js';

describe('codexHome', () => {
  it('defaults to ~/.codex and honors CODEX_HOME', () => {
    expect(codexHome({}, '/home/u')).toBe(path.join('/home/u', '.codex'));
    expect(codexSessionsRoot({}, '/home/u')).toBe(path.join('/home/u', '.codex', 'sessions'));
    expect(codexArchivedRoot({}, '/home/u')).toBe(path.join('/home/u', '.codex', 'archived_sessions'));
    expect(codexHome({ CODEX_HOME: '/srv/codex' }, '/home/u')).toBe('/srv/codex');
    expect(codexSessionsRoot({ CODEX_HOME: '/srv/codex' }, '/home/u')).toBe(path.join('/srv/codex', 'sessions'));
    expect(codexArchivedRoot({ CODEX_HOME: '/srv/codex' }, '/home/u')).toBe(path.join('/srv/codex', 'archived_sessions'));
    expect(codexHome({ CODEX_HOME: '' }, '/home/u')).toBe(path.join('/home/u', '.codex'));
  });
});

// Every Codex reader must find files under a custom CODEX_HOME by default, sessions and archived
// alike, the same home limits/account.ts reads the login from.
describe('Codex readers follow CODEX_HOME', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    vi.stubEnv('CODEX_HOME', home);
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

  const write = (rel: string, body = ''): string => {
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    return f;
  };

  it('the limits locator finds a live and an archived session', () => {
    const live = write('sessions/2026/11/05/rollout-2026-11-05T10-00-00-live1.jsonl');
    const old = write('archived_sessions/rollout-2026-10-01T10-00-00-arch1.jsonl');
    expect(locateCodexTranscript('live1')).toBe(live);
    expect(locateCodexTranscript('arch1')).toBe(old);
  });

  it('the conversation reader and boot recovery find the rollout', () => {
    const f = write('sessions/2026/11/05/rollout-2026-11-05T10-00-00-conv1.jsonl', '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    expect(findCodexRolloutPath('conv1')).toBe(f);
    expect(codexRolloutTailStatus('conv1')?.completed).toBe(true);
  });

  it('the thread namer finds the rollout', async () => {
    const f = write('sessions/2026/11/05/rollout-2026-11-05T10-00-00-name1.jsonl');
    expect(await resolveTranscriptPath({ type: 'codex', externalId: 'name1', workingDir: null }, '/tmp')).toBe(f);
  });

  it('the account reader reads the same home', () => {
    write('auth.json', JSON.stringify({ tokens: { account_id: 'acct-custom' } }));
    expect(codexAccountId()).toBe('acct-custom');
  });

  it('the title namer reads the model list from the same home', () => {
    write('models_cache.json', JSON.stringify({ models: [{ slug: CODEX_TITLE_MODELS[0] }] }));
    expect(codexModelsCachePath()).toBe(path.join(home, 'models_cache.json'));
    expect(pickCodexTitleModel()).toBe(CODEX_TITLE_MODELS[0]);
  });
});

// Owner guardrail: with CODEX_HOME unset, every path is byte-identical to the hardcoded one it replaced.
describe('CODEX_HOME unset: paths unchanged', () => {
  let saved: string | undefined;
  let fakeHome: string;
  beforeEach(() => {
    saved = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-default-'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
    vi.restoreAllMocks();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('the resolver returns exactly the old strings', () => {
    expect(codexHome()).toBe(path.join(os.homedir(), '.codex'));
    expect(codexSessionsRoot()).toBe(path.join(os.homedir(), '.codex', 'sessions'));
    expect(codexArchivedRoot()).toBe(path.join(os.homedir(), '.codex', 'archived_sessions'));
  });

  it('every reader still looks under <home>/.codex', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const put = (rel: string, body = ''): string => {
      const f = path.join(fakeHome, '.codex', rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
      return f;
    };
    const live = put('sessions/2026/11/05/rollout-2026-11-05T10-00-00-d1.jsonl');
    const old = put('archived_sessions/rollout-2026-10-01T10-00-00-d2.jsonl');
    put('auth.json', JSON.stringify({ tokens: { account_id: 'acct-default' } }));
    expect(locateCodexTranscript('d1')).toBe(live);
    expect(locateCodexTranscript('d2')).toBe(old);
    expect(findCodexRolloutPath('d1')).toBe(live);
    expect(await resolveTranscriptPath({ type: 'codex', externalId: 'd1', workingDir: null }, '/tmp')).toBe(live);
    expect(codexAccountId()).toBe('acct-default');
    expect(codexModelsCachePath()).toBe(path.join(fakeHome, '.codex', 'models_cache.json'));
  });
});
