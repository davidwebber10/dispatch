import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyDurableSources, findNewestUnresolvedUserUuid } from '../../src/sessions/cc-sessions.js';

describe('applyDurableSources', () => {
  it('attaches meta.source to a user event whose uuid is in the map', () => {
    const events = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', uuid: 'u2', message: { content: [{ type: 'text', text: 'hello' }] } },
    ];
    const out = applyDurableSources(events, new Map([['u1', 'coordinator']])) as any[];
    expect(out[0].meta).toEqual({ source: 'coordinator' });
    expect(out[1].meta).toBeUndefined(); // assistant events are never tagged
  });

  it('leaves events untouched when their uuid has no durable tag', () => {
    const events = [{ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }];
    const out = applyDurableSources(events, new Map([['u-other', 'coordinator']])) as any[];
    expect(out[0]).toEqual(events[0]); // untouched — same shape, no `meta` key added
  });

  it('is a no-op (returns the same array) when the map is empty', () => {
    const events = [{ type: 'user', uuid: 'u1', message: { role: 'user', content: [] } }];
    expect(applyDurableSources(events, new Map())).toBe(events);
  });

  it('preserves an existing meta field instead of clobbering it', () => {
    const events = [{ type: 'user', uuid: 'u1', message: { role: 'user', content: [] }, meta: { other: true } }];
    const out = applyDurableSources(events, new Map([['u1', 'user']])) as any[];
    expect(out[0].meta).toEqual({ other: true, source: 'user' });
  });

  it('skips events with no uuid or a non-user type', () => {
    const events = [
      { type: 'user', message: { role: 'user', content: [] } }, // no uuid
      { type: 'result', subtype: 'backfill' },
    ];
    const out = applyDurableSources(events, new Map([['whatever', 'coordinator']])) as any[];
    expect(out).toEqual(events);
  });
});

describe('findNewestUnresolvedUserUuid', () => {
  const realHome = process.env.HOME;
  let home: string;
  const workDir = '/tmp/message-source-proj';
  const projDir = () => path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'message-source-home-'));
    process.env.HOME = home;
    fs.mkdirSync(projDir(), { recursive: true });
  });
  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeTranscript(id: string, lines: unknown[]): void {
    fs.writeFileSync(path.join(projDir(), `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  it('finds the newest real-text user uuid not already excluded', () => {
    writeTranscript('sess-a', [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'assistant', uuid: 'u2', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
    ]);
    expect(findNewestUnresolvedUserUuid(workDir, 'sess-a', new Set())).toBe('u3');
    expect(findNewestUnresolvedUserUuid(workDir, 'sess-a', new Set(['u3']))).toBe('u1');
    expect(findNewestUnresolvedUserUuid(workDir, 'sess-a', new Set(['u1', 'u3']))).toBeUndefined();
  });

  it('skips tool_result-only user lines (not a real human/coordinator turn)', () => {
    writeTranscript('sess-b', [
      { type: 'assistant', uuid: 'u1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'text', text: 'real turn' }] } },
    ]);
    expect(findNewestUnresolvedUserUuid(workDir, 'sess-b', new Set())).toBe('u3');
  });

  it('skips isMeta and isSidechain lines', () => {
    writeTranscript('sess-c', [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'real' }] } },
      { type: 'user', isMeta: true, uuid: 'u2', message: { role: 'user', content: 'injected context' } },
      { type: 'user', isSidechain: true, uuid: 'u3', message: { role: 'user', content: [{ type: 'text', text: 'subagent' }] } },
    ]);
    expect(findNewestUnresolvedUserUuid(workDir, 'sess-c', new Set())).toBe('u1');
  });

  it('handles a plain-string content shape (resumed/backfilled transcripts)', () => {
    writeTranscript('sess-d', [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'plain string turn' } },
    ]);
    expect(findNewestUnresolvedUserUuid(workDir, 'sess-d', new Set())).toBe('u1');
  });

  it('returns undefined when the transcript is missing', () => {
    expect(findNewestUnresolvedUserUuid(workDir, 'no-such-session', new Set())).toBeUndefined();
  });
});
