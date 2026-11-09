import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resumeAdvice, findNewestUnresolvedUserUuid, readTerminalTokenUsage, sumTranscriptTokens, readSessionBackfill, backfillEventsFromTranscript, tokenTotalsCache } from './cc-sessions.js';
import { clearTranscriptPathCache } from './transcript-path.js';
import { isInjectedUserEntry } from '../conversation/task-notification.js';

describe('resumeAdvice', () => {
  let home: string;
  let origHome: string | undefined;
  const workDir = '/tmp/proj';

  // Claude Code encodes the workdir by replacing every "/" with "-".
  function writeTranscript(sessionId: string, lines: unknown[]) {
    const dir = path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  function assistant(timestamp: string, usage: Record<string, number>) {
    return { type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage } };
  }

  const BIG = { input_tokens: 20_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 4_000 };
  const SMALL = { input_tokens: 500, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 };
  const NOW = Date.parse('2026-07-19T12:00:00.000Z');
  const THREE_HOURS_AGO = '2026-07-19T09:00:00.000Z';
  const TEN_MINUTES_AGO = '2026-07-19T11:50:00.000Z';

  beforeEach(() => {
    origHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-advice-'));
    process.env.HOME = home;
    delete process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES;
    delete process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('prompts when the session is both old and large', () => {
    writeTranscript('s1', [assistant(THREE_HOURS_AGO, BIG)]);
    const advice = resumeAdvice(workDir, 's1', NOW);
    expect(advice).not.toBeNull();
    expect(advice!.shouldPrompt).toBe(true);
    expect(Math.round(advice!.ageMinutes)).toBe(180);
    expect(advice!.contextTokens).toBe(124_000);
  });

  it('does not prompt when the session is large but recent', () => {
    writeTranscript('s2', [assistant(TEN_MINUTES_AGO, BIG)]);
    expect(resumeAdvice(workDir, 's2', NOW)!.shouldPrompt).toBe(false);
  });

  it('does not prompt when the session is old but small', () => {
    writeTranscript('s3', [assistant(THREE_HOURS_AGO, SMALL)]);
    expect(resumeAdvice(workDir, 's3', NOW)!.shouldPrompt).toBe(false);
  });

  it('honors the CLI threshold env vars', () => {
    writeTranscript('s4', [assistant(TEN_MINUTES_AGO, SMALL)]);
    process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES = '5';
    process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = '1000';
    expect(resumeAdvice(workDir, 's4', NOW)!.shouldPrompt).toBe(true);
  });

  it('uses the LAST assistant usage, not a sum across turns', () => {
    writeTranscript('s5', [assistant(THREE_HOURS_AGO, BIG), assistant(THREE_HOURS_AGO, SMALL)]);
    expect(resumeAdvice(workDir, 's5', NOW)!.contextTokens).toBe(1_500);
  });

  it('returns null when the transcript is missing', () => {
    expect(resumeAdvice(workDir, 'nope', NOW)).toBeNull();
  });

  // Boundary precision: the gate is `>=` on both dimensions, not `>`. Every other test in
  // this file sits far from the boundary (3h/BIG vs. 10m/SMALL), so accidentally flipping
  // either `>=` to `>` would still leave them all green.
  describe('boundary precision (the gate is >=, not >)', () => {
    it('prompts when age is EXACTLY 70 minutes and tokens EXACTLY 100,000', () => {
      const t = NOW - 70 * 60_000;
      writeTranscript('boundary-both', [assistant(new Date(t).toISOString(), { input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
      expect(resumeAdvice(workDir, 'boundary-both', NOW)!.shouldPrompt).toBe(true);
    });

    it('does not prompt when age is a hair under 70 minutes (tokens still at the threshold)', () => {
      const t = NOW - (70 * 60_000 - 1);
      writeTranscript('boundary-age-under', [assistant(new Date(t).toISOString(), { input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
      expect(resumeAdvice(workDir, 'boundary-age-under', NOW)!.shouldPrompt).toBe(false);
    });

    it('does not prompt when tokens are a hair under 100,000 (age still at the threshold)', () => {
      const t = NOW - 70 * 60_000;
      writeTranscript('boundary-tok-under', [assistant(new Date(t).toISOString(), { input_tokens: 99_999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]);
      expect(resumeAdvice(workDir, 'boundary-tok-under', NOW)!.shouldPrompt).toBe(false);
    });
  });

  // The two threshold env vars must be read INDEPENDENTLY. The existing "honors the CLI
  // threshold env vars" test above sets BOTH at once, so a bug that read the SAME var for
  // both thresholds would still pass it.
  describe('threshold env vars are read independently', () => {
    it('honors the age threshold env var alone — the token threshold still uses its 100k default', () => {
      // Aged past a tiny custom age threshold, but nowhere near the real 100k token default.
      writeTranscript('s6', [assistant(TEN_MINUTES_AGO, SMALL)]);
      process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES = '5';
      // CLAUDE_CODE_RESUME_TOKEN_THRESHOLD deliberately left unset.
      // A bug that reused this var for the token threshold too (5) would flip this to true,
      // since SMALL's 1,500 tokens clears 5 easily.
      expect(resumeAdvice(workDir, 's6', NOW)!.shouldPrompt).toBe(false);
    });

    it('honors the token threshold env var alone — the age threshold still uses its 70m default', () => {
      // Well past the tiny custom token threshold, but nowhere near the real 70m age default.
      writeTranscript('s7', [assistant(TEN_MINUTES_AGO, BIG)]);
      process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = '5';
      // CLAUDE_CODE_RESUME_THRESHOLD_MINUTES deliberately left unset.
      // A bug that reused this var for the age threshold too (5) would flip this to true,
      // since 10 minutes clears an age threshold of 5 easily.
      expect(resumeAdvice(workDir, 's7', NOW)!.shouldPrompt).toBe(false);
    });
  });
});

// ── W1-E: bounded tail reads ────────────────────────────────────────────────────────────────
describe('bounded tail reads', () => {
  let home: string;
  let origHome: string | undefined;
  const workDir = '/tmp/tail-proj';
  const fileOf = (sessionId: string) => path.join(home, '.claude', 'projects', workDir.replace(/\//g, '-'), `${sessionId}.jsonl`);

  beforeEach(() => {
    origHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tail-'));
    process.env.HOME = home;
    fs.mkdirSync(path.dirname(fileOf('x')), { recursive: true });
    clearTranscriptPathCache();
    tokenTotalsCache.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const user = (uuid: string, text: string, extra: Record<string, unknown> = {}) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
  const toolResult = (uuid: string) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] } });
  const assistant = (uuid: string, id: string, text: string, usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 3 }) =>
    ({ type: 'assistant', uuid, message: { id, role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text }], usage } });
  const write = (sessionId: string, lines: unknown[], trailingNewline = true) =>
    fs.writeFileSync(fileOf(sessionId), lines.map((l) => JSON.stringify(l)).join('\n') + (trailingNewline ? '\n' : ''));

  /** The algorithm before W1-E: read the whole file, keep the last match. */
  function fullReadNewest(sessionId: string, exclude: Set<string>): string | undefined {
    let found: string | undefined;
    for (const line of fs.readFileSync(fileOf(sessionId), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.type !== 'user' || o.isMeta || o.isSidechain || typeof o.uuid !== 'string' || exclude.has(o.uuid)) continue;
      if (isInjectedUserEntry(o)) continue;
      const c = o.message?.content;
      const real = typeof c === 'string' ? c.trim().length > 0 : Array.isArray(c) ? c.some((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) : false;
      if (real) found = o.uuid;
    }
    return found;
  }

  /** One real question at the head, then `kb` KB of turns that are never an answer, then a tail. */
  function fixture(sessionId: string, kb: number, tail: unknown[]) {
    const lines: unknown[] = [user('head-1', 'the first question'), assistant('ha', 'm0', 'ok')];
    const pad = 'p'.repeat(900);
    for (let i = 0; i < kb; i++) {
      lines.push(i % 3 === 0 ? toolResult(`tr-${i}`) : i % 3 === 1 ? assistant(`a-${i}`, `m-${i}`, pad) : user(`meta-${i}`, pad, { isMeta: true }));
    }
    lines.push(...tail);
    write(sessionId, lines);
  }

  it('findNewestUnresolvedUserUuid gives the same answer as the full read on the fixture', () => {
    const tail = [user('side', 'sub-agent', { isSidechain: true }), user('real-1', 'a real question'), assistant('a1', 'mA', 'answer'),
      toolResult('tr-last'), user('cmd', '<command-name>/compact</command-name>'), user('real-2', 'the newest question'), assistant('a2', 'mB', 'answer')];
    fixture('small', 20, tail);     // under 256 KB: one read
    fixture('wide', 3000, tail);    // about 3 MB: the head question needs a wider read
    for (const id of ['small', 'wide']) {
      for (const exclude of [new Set<string>(), new Set(['real-2']), new Set(['real-2', 'real-1']), new Set(['real-2', 'real-1', 'head-1'])]) {
        expect(findNewestUnresolvedUserUuid(workDir, id, exclude)).toBe(fullReadNewest(id, exclude));
      }
    }
    expect(findNewestUnresolvedUserUuid(workDir, 'wide', new Set(['real-2', 'real-1']))).toBe('head-1');
    expect(findNewestUnresolvedUserUuid(workDir, 'wide', new Set())).toBe('real-2');
  });

  it('it reads at most 256 KB when the answer is in the tail', () => {
    fixture('big', 3000, [user('real-2', 'the newest question'), assistant('a2', 'mB', 'answer')]);
    expect(fs.statSync(fileOf('big')).size).toBeGreaterThan(2 * 1024 * 1024);
    const readSync = vi.spyOn(fs, 'readSync');
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    expect(findNewestUnresolvedUserUuid(workDir, 'big', new Set())).toBe('real-2');
    const bytes = readSync.mock.results.reduce((n, r) => n + (typeof r.value === 'number' ? r.value : 0), 0);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(256 * 1024 + 1); // + the one byte that tells if the cut is on a line start
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('token totals after an append equal the totals of a full read', () => {
    const first = [user('u1', 'q'), assistant('a1', 'm1', 'one'), assistant('a1b', 'm1', 'the same message, second block'), assistant('a2', 'm2', 'two')];
    write('tok', first);
    expect(readTerminalTokenUsage(workDir, 'tok')).toEqual(sumTranscriptTokens(fs.readFileSync(fileOf('tok'), 'utf-8')));

    // Appended: a second block of m2 (already counted), a new message, and a new model.
    const more = [assistant('a2b', 'm2', 'two again'), assistant('a3', 'm3', 'three', { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 }),
      { type: 'assistant', uuid: 'a4', message: { id: 'm4', role: 'assistant', model: 'claude-opus-4-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }];
    fs.appendFileSync(fileOf('tok'), more.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const sizeBefore = fs.statSync(fileOf('tok')).size;
    const appended = Buffer.byteLength(more.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const readSync = vi.spyOn(fs, 'readSync');
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const after = readTerminalTokenUsage(workDir, 'tok');
    const bytes = readSync.mock.results.reduce((n, r) => n + (typeof r.value === 'number' ? r.value : 0), 0);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(bytes).toBe(appended); // only the new bytes
    vi.restoreAllMocks();
    expect(fs.statSync(fileOf('tok')).size).toBe(sizeBefore);
    const full = sumTranscriptTokens(fs.readFileSync(fileOf('tok'), 'utf-8'));
    expect(after).toEqual(full);
    expect(after!.messageCount).toBe(4);
    expect(after!.model).toBe('claude-opus-4-5');

    // No change: no bytes are read, and the totals stay.
    const idle = vi.spyOn(fs, 'readSync');
    expect(readTerminalTokenUsage(workDir, 'tok')).toEqual(full);
    expect(idle).not.toHaveBeenCalled();
  });

  it('token totals: a line that is still being written is counted once', () => {
    write('part', [assistant('a1', 'm1', 'one')]);
    const whole = JSON.stringify(assistant('a2', 'm2', 'two'));
    fs.appendFileSync(fileOf('part'), whole.slice(0, 40)); // half a line: not JSON yet
    expect(readTerminalTokenUsage(workDir, 'part')).toEqual(sumTranscriptTokens(fs.readFileSync(fileOf('part'), 'utf-8')));
    fs.appendFileSync(fileOf('part'), whole.slice(40)); // a whole line, with no newline yet
    expect(readTerminalTokenUsage(workDir, 'part')).toEqual(sumTranscriptTokens(fs.readFileSync(fileOf('part'), 'utf-8')));
    expect(readTerminalTokenUsage(workDir, 'part')!.messageCount).toBe(2);
    fs.appendFileSync(fileOf('part'), '\n' + JSON.stringify(assistant('a3', 'm3', 'three')) + '\n');
    const end = readTerminalTokenUsage(workDir, 'part');
    expect(end).toEqual(sumTranscriptTokens(fs.readFileSync(fileOf('part'), 'utf-8')));
    expect(end!.messageCount).toBe(3);
  });

  it('token totals: a smaller file resets the cache', () => {
    write('shrink', [assistant('a1', 'm1', 'one'), assistant('a2', 'm2', 'two'), assistant('a3', 'm3', 'three')]);
    expect(readTerminalTokenUsage(workDir, 'shrink')!.messageCount).toBe(3);
    write('shrink', [assistant('b1', 'n1', 'x')]);
    const r = readTerminalTokenUsage(workDir, 'shrink');
    expect(r).toEqual(sumTranscriptTokens(fs.readFileSync(fileOf('shrink'), 'utf-8')));
    expect(r!.messageCount).toBe(1);
  });

  it('token totals: a missing transcript gives null', () => {
    expect(readTerminalTokenUsage(workDir, 'no-such')).toBeNull();
  });

  it('backfill returns the same events as before for a file under 2 MB', () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 300; i++) { lines.push(user(`u-${i}`, `question ${i} ` + 'q'.repeat(500)), assistant(`a-${i}`, `m-${i}`, `answer ${i} ` + 'r'.repeat(900))); }
    write('bf', lines);
    const size = fs.statSync(fileOf('bf')).size;
    expect(size).toBeLessThan(2 * 1024 * 1024);
    const before = backfillEventsFromTranscript(fs.readFileSync(fileOf('bf'), 'utf-8'), 2000);
    expect(readSessionBackfill(workDir, 'bf')).toEqual(before);
    expect(before.length).toBe(601); // 600 turns + the synthetic result
    expect(readSessionBackfill(workDir, 'bf', 50)).toEqual(backfillEventsFromTranscript(fs.readFileSync(fileOf('bf'), 'utf-8'), 50));
  });

  it('backfill of a larger file reads the tail only, and widens until it has `limit` events', () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 2500; i++) { lines.push(user(`u-${i}`, `question ${i} ` + 'q'.repeat(500)), assistant(`a-${i}`, `m-${i}`, `answer ${i} ` + 'r'.repeat(900))); }
    write('bfbig', lines);
    const size = fs.statSync(fileOf('bfbig')).size;
    expect(size).toBeGreaterThan(4 * 1024 * 1024);
    const full = fs.readFileSync(fileOf('bfbig'), 'utf-8');

    // 100 events are in the last 2 MB: one read of 2 MB.
    const readSync = vi.spyOn(fs, 'readSync');
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const small = readSessionBackfill(workDir, 'bfbig', 100);
    const bytes = readSync.mock.results.reduce((n, r) => n + (typeof r.value === 'number' ? r.value : 0), 0);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 1);
    vi.restoreAllMocks();
    expect(small).toEqual(backfillEventsFromTranscript(full, 100));

    // 2,000 events are not in the last 2 MB: the read widens, and the answer is the same as the full read.
    expect(readSessionBackfill(workDir, 'bfbig')).toEqual(backfillEventsFromTranscript(full, 2000));
  });
});
