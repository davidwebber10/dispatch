import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanName, deriveThreadName, resolveTranscriptPath } from '../../src/sessions/thread-namer.js';
import { platform } from '../../src/platform/index.js';

const CC_WITH_SUMMARY = [
  '{"type":"summary","summary":"Fix login redirect loop"}',
  '{"message":{"role":"user","content":"why does the login page loop forever after oauth"}}',
].join('\n');
const CC_PROMPT_ONLY = '{"message":{"role":"user","content":"add dark mode to the settings page please"}}';
const CC_NOISE_FIRST = [
  '{"isMeta":true,"message":{"role":"user","content":"<system-hint>x</system-hint>"}}',
  '{"message":{"role":"user","content":"<local-command-caveat>y</local-command-caveat>"}}',
  '{"message":{"role":"user","content":"rename the widget"}}',
].join('\n');

// Real codex rollout line shape per codex-sessions.ts: session_meta first, then
// response_item/message lines with role + content blocks tagged input_text/text/output_text.
const CODEX_TRANSCRIPT = [
  JSON.stringify({ type: 'session_meta', payload: { session_id: 'sess-codex-1', cwd: '/work/proj' } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<context>ignore me</context>' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok, on it' }] } }),
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the flaky login test' }] } }),
].join('\n');

describe('deriveThreadName', () => {
  test('summary wins', () => expect(deriveThreadName(CC_WITH_SUMMARY, 'claude')).toBe('Fix login redirect loop'));
  test('first prompt when no summary', () => expect(deriveThreadName(CC_PROMPT_ONLY, 'claude')).toBe('add dark mode to the settings page please'));
  test('meta and <-prefixed messages skipped', () => expect(deriveThreadName(CC_NOISE_FIRST, 'claude')).toBe('rename the widget'));
  test('empty/garbage → null', () => {
    expect(deriveThreadName('', 'claude')).toBeNull();
    expect(deriveThreadName('not json at all', 'claude')).toBeNull();
  });
  test('codex: first real user message wins, session_meta/assistant/<-prefixed skipped', () => {
    expect(deriveThreadName(CODEX_TRANSCRIPT, 'codex')).toBe('fix the flaky login test');
  });
  test('codex: empty/garbage → null', () => {
    expect(deriveThreadName('', 'codex')).toBeNull();
    expect(deriveThreadName('not json at all', 'codex')).toBeNull();
  });
});

describe('cleanName', () => {
  test('collapses and cuts on word boundary', () => {
    expect(cleanName('  fix   the\n\nlogin  ')).toBe('fix the login');
    const long = 'implement the frobnicator subsystem with retries and backoff for the flaky api';
    const cut = cleanName(long)!;
    expect(cut.length).toBeLessThanOrEqual(48);
    expect(long.startsWith(cut)).toBe(true);
    expect(cut.endsWith(' ')).toBe(false);
    expect(long[cut.length]).toBe(' ');   // word boundary, no mid-word cut
  });
  test('empty after cleaning → null', () => {
    expect(cleanName('')).toBeNull();
    expect(cleanName('   \n\t  ')).toBeNull();
  });
  test('hard-cuts at 48 when the first word alone exceeds it', () => {
    const long = 'a'.repeat(60);
    const cut = cleanName(long)!;
    expect(cut).toBe('a'.repeat(48));
  });
  test('strips leading command punctuation', () => {
    expect(cleanName('/review fix the tests')).toBe('review fix the tests');
    expect(cleanName('!!!hello')).toBe('hello');
  });
  test('punctuation-only input → null', () => {
    expect(cleanName('...!!! ,,, ---')).toBeNull();
  });
  test('interior punctuation is left untouched', () => {
    expect(cleanName('fix the CI: step 2')).toBe('fix the CI: step 2');
  });
});

describe('resolveTranscriptPath', () => {
  test('claude-code: joins the platform project dir + externalId.jsonl', async () => {
    const result = await resolveTranscriptPath({ type: 'claude-code', externalId: 'sess-1', workingDir: '/work/proj' }, '/other/dir');
    expect(result).toBe(path.join(platform.claudeProjectDir('/work/proj'), 'sess-1.jsonl'));
  });
  test('claude-code: falls back to sessionWorkingDir when workingDir is null', async () => {
    const result = await resolveTranscriptPath({ type: 'claude-code', externalId: 'sess-1', workingDir: null }, '/other/dir');
    expect(result).toBe(path.join(platform.claudeProjectDir('/other/dir'), 'sess-1.jsonl'));
  });
  test('null externalId → null', async () => {
    expect(await resolveTranscriptPath({ type: 'claude-code', externalId: null, workingDir: '/work/proj' }, '/other')).toBeNull();
    expect(await resolveTranscriptPath({ type: 'codex', externalId: null, workingDir: '/work/proj' }, '/other')).toBeNull();
  });
  test('unknown type → null', async () => {
    expect(await resolveTranscriptPath({ type: 'shell', externalId: 'sess-1', workingDir: '/work/proj' }, '/other')).toBeNull();
  });

  describe('codex', () => {
    let root: string;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexroot-')); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    function writeRollout(rel: string) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '');
      return full;
    }

    test('finds the rollout file ending in -<sessionId>.jsonl under the date tree', async () => {
      const full = writeRollout('2026/06/01/rollout-2026-06-01T12-00-00-sess-codex-1.jsonl');
      const result = await resolveTranscriptPath({ type: 'codex', externalId: 'sess-codex-1', workingDir: '/work/proj' }, '/other', root);
      expect(result).toBe(full);
    });
    test('returns null when no matching rollout exists', async () => {
      writeRollout('2026/06/01/rollout-2026-06-01T12-00-00-other-id.jsonl');
      const result = await resolveTranscriptPath({ type: 'codex', externalId: 'sess-codex-1', workingDir: '/work/proj' }, '/other', root);
      expect(result).toBeNull();
    });
    test('returns null when the sessions root is missing', async () => {
      const result = await resolveTranscriptPath({ type: 'codex', externalId: 'sess-codex-1', workingDir: '/work/proj' }, '/other', path.join(root, 'nope'));
      expect(result).toBeNull();
    });
  });
});
