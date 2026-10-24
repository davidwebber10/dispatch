import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSessionSettings } from './cc-sessions.js';
import { clearTranscriptPathCache } from './transcript-path.js';

describe('readSessionSettings', () => {
  let home: string;
  let origHome: string | undefined;
  const workDir = '/tmp/proj';

  function write(sessionId: string, lines: unknown[]) {
    const dir = path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  }
  const turn = (over: Record<string, unknown> = {}, model = 'claude-opus-5-5') => ({
    type: 'assistant', isSidechain: false, requestedModel: model, effort: 'high',
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'hi' }] }, ...over,
  });

  beforeEach(() => {
    origHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-settings-'));
    process.env.HOME = home;
    clearTranscriptPathCache();
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
    clearTranscriptPathCache();
  });

  it('returns the requested model and effort of the last lead turn', () => {
    write('s1', [turn({ effort: 'xhigh' }, 'claude-fable-5-1'), turn({ effort: 'high' }, 'claude-opus-5-5')]);
    expect(readSessionSettings(workDir, 's1')).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
  });

  it('ignores sub-agent (sidechain) turns', () => {
    write('s1', [turn(), turn({ isSidechain: true, effort: 'low' }, 'claude-haiku-5-5')]);
    expect(readSessionSettings(workDir, 's1')).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
  });

  it('ignores synthetic entries', () => {
    write('s1', [turn(), { type: 'assistant', requestedModel: null, effort: null, message: { model: '<synthetic>', content: [] } }]);
    expect(readSessionSettings(workDir, 's1')).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
  });

  it('uses the REQUESTED model, not a fallback model that answered', () => {
    write('s1', [turn({ requestedModel: 'claude-fable-5-1', message: { model: 'claude-opus-5-5', content: [] } })]);
    expect(readSessionSettings(workDir, 's1')?.model).toBe('claude-fable-5-1');
  });

  it('drops values it does not recognise', () => {
    write('s1', [turn({ effort: 'banana', requestedModel: 'not a model; rm -rf' })]);
    expect(readSessionSettings(workDir, 's1')).toEqual({});
  });

  it('returns null when there is no transcript or no assistant turn', () => {
    expect(readSessionSettings(workDir, 'missing')).toBeNull();
    write('s2', [{ type: 'user', message: { content: 'hello' } }]);
    expect(readSessionSettings(workDir, 's2')).toBeNull();
  });
});
