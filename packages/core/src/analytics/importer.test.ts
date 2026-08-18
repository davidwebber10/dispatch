import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { importHistory, clearStaleImportState } from './importer.js';
import { readBackfillState, writeBackfillState } from './backfill-state.js';

const CUTOFF = '2026-08-13T00:00:00.000Z';

function line(at: string, output: number) {
  return JSON.stringify({
    type: 'assistant', timestamp: at,
    message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
}

describe('history importer', () => {
  let dir: string;
  let d: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-import-'));
    d = new Database(':memory:');
    initSchema(d);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeTranscript(name: string, lines: string[]) {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  it('imports turns older than the cutoff and marks them backfilled', () => {
    const file = writeTranscript('s1', [line('2026-08-10T10:00:00.000Z', 20)]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'claude-code', role: 'agent', transcriptPath: file }] });
    expect(res.imported).toBe(1);
    const row = d.prepare('SELECT * FROM usage_turns').get() as any;
    expect(row.backfilled).toBe(1);
    expect(row.output_tokens).toBe(20);
  });

  // The safety property: live recording owns everything at or after the cutoff.
  it('refuses data at or after the cutoff', () => {
    const file = writeTranscript('s2', [line('2026-08-13T09:00:00.000Z', 20), line(CUTOFF, 5)]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'claude-code', role: '', transcriptPath: file }] });
    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(2);
  });

  it('is idempotent — a second run replaces imported rows, not adds to them', () => {
    const file = writeTranscript('s3', [line('2026-08-10T10:00:00.000Z', 20)]);
    const threads = [{ terminalId: 'term1', projectId: 'proj1', provider: 'claude-code', role: '', transcriptPath: file }];
    importHistory(d, { cutoff: CUTOFF, threads });
    importHistory(d, { cutoff: CUTOFF, threads });
    const n = (d.prepare('SELECT COUNT(*) AS n FROM usage_turns').get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('leaves live rows untouched', () => {
    d.prepare(`INSERT INTO usage_turns (id, terminal_id, project_id, provider, started_at, ended_at, outcome, output_tokens)
               VALUES ('live','term1','proj1','claude-code','2026-08-14T10:00:00.000Z','2026-08-14T10:00:05.000Z','idle',7)`).run();
    const file = writeTranscript('s4', [line('2026-08-10T10:00:00.000Z', 20)]);
    importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'claude-code', role: '', transcriptPath: file }] });
    const live = d.prepare(`SELECT * FROM usage_turns WHERE id = 'live'`).get() as any;
    expect(live.output_tokens).toBe(7);
  });

  it('skips a thread whose transcript is missing', () => {
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'grok', role: '', transcriptPath: path.join(dir, 'nope.jsonl') }] });
    expect(res.imported).toBe(0);
    expect(res.threads).toBe(0);
  });

  it('tolerates a blank line, malformed JSON, and a usage line with no timestamp — only the good line imports', () => {
    const noTimestamp = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    const file = writeTranscript('s5', [
      '',
      'not json at all {{{',
      noTimestamp,
      line('2026-08-10T10:00:00.000Z', 20),
    ]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'claude-code', role: '', transcriptPath: file }] });
    expect(res.imported).toBe(1);
    // The blank line and the malformed-JSON line are silently ignored (never
    // counted, in either direction); only the usage-bearing line missing a
    // timestamp is counted as skipped.
    expect(res.skipped).toBe(1);
    const rows = d.prepare('SELECT * FROM usage_turns').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].output_tokens).toBe(20);
  });
});

describe('history importer — Codex', () => {
  let dir: string;
  let d: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-import-codex-'));
    d = new Database(':memory:');
    initSchema(d);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeTranscript(name: string, lines: string[]) {
    const file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  function tokenCount(at: string, input: number, cached: number, output: number) {
    return JSON.stringify({
      timestamp: at,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input, cached_input_tokens: cached,
            output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
          },
          // Deliberately absurd: proves the importer never reads this field.
          last_token_usage: { input_tokens: 999999, cached_input_tokens: 0, output_tokens: 999999, reasoning_output_tokens: 0, total_tokens: 1999998 },
        },
      },
    });
  }

  function turnContext(at: string, model: string) {
    return JSON.stringify({ timestamp: at, type: 'turn_context', payload: { model } });
  }

  it('imports Codex history by diffing the running total against a zero baseline', () => {
    const file = writeTranscript('cx1', [
      turnContext('2026-08-10T09:00:00.000Z', 'gpt-5.6-sol'),
      tokenCount('2026-08-10T09:00:01.000Z', 100, 20, 30),
    ]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'codex', role: 'agent', transcriptPath: file }] });
    expect(res.imported).toBe(1);
    const row = d.prepare('SELECT * FROM usage_turns').get() as any;
    expect(row.model).toBe('gpt-5.6-sol');
    expect(row.provider).toBe('codex');
    expect(row.cache_read_tokens).toBe(20);
    expect(row.input_tokens).toBe(80); // input_tokens(100) - cached_input_tokens(20)
    expect(row.output_tokens).toBe(30);
    expect(row.cache_create_tokens).toBe(0);
    expect(row.backfilled).toBe(1);
  });

  it('walks token_count events forward, diffing consecutive totals and attributing each diff to the most recent preceding turn_context', () => {
    const file = writeTranscript('cx2', [
      turnContext('2026-08-10T09:00:00.000Z', 'gpt-5.6-sol'),
      tokenCount('2026-08-10T09:00:01.000Z', 100, 20, 30),
      turnContext('2026-08-10T09:00:02.000Z', 'gpt-5.6-terra'), // mid-session /model switch
      tokenCount('2026-08-10T09:00:03.000Z', 250, 60, 70),
    ]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'codex', role: '', transcriptPath: file }] });
    expect(res.imported).toBe(2);
    const rows = d.prepare('SELECT * FROM usage_turns ORDER BY started_at').all() as any[];
    expect(rows[0].model).toBe('gpt-5.6-sol');
    expect(rows[0].input_tokens).toBe(80);
    expect(rows[0].cache_read_tokens).toBe(20);
    expect(rows[0].output_tokens).toBe(30);

    // Second step diffs against the FIRST total, not zero: input 150, cached 40, output 40.
    expect(rows[1].model).toBe('gpt-5.6-terra');
    expect(rows[1].input_tokens).toBe(110); // 150 - 40
    expect(rows[1].cache_read_tokens).toBe(40);
    expect(rows[1].output_tokens).toBe(40);
  });

  it('refuses a Codex token_count at or after the cutoff', () => {
    const file = writeTranscript('cx3', [
      turnContext('2026-08-10T08:00:00.000Z', 'gpt-5.6-sol'),
      tokenCount('2026-08-10T09:00:00.000Z', 100, 20, 30),
      tokenCount(CUTOFF, 200, 20, 30),
    ]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'codex', role: '', transcriptPath: file }] });
    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it('guards a negative diff by skipping that step, without corrupting the diff of the step after it', () => {
    const file = writeTranscript('cx4', [
      turnContext('2026-08-10T08:00:00.000Z', 'gpt-5.6-sol'),
      tokenCount('2026-08-10T09:00:00.000Z', 100, 20, 30),
      tokenCount('2026-08-10T09:00:01.000Z', 50, 10, 10), // total moved backwards — never observed for real, guarded defensively
      tokenCount('2026-08-10T09:00:02.000Z', 150, 30, 50),
    ]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'codex', role: '', transcriptPath: file }] });
    expect(res.imported).toBe(2);
    expect(res.skipped).toBe(1);
    const rows = d.prepare('SELECT * FROM usage_turns ORDER BY started_at').all() as any[];
    expect(rows.length).toBe(2);
    // The skipped step still advances the baseline to (50,10,10), so the third
    // step's diff is against THAT, not against the pre-reset (100,20,30).
    expect(rows[1].input_tokens).toBe(80); // (150-50) - (30-10)
    expect(rows[1].cache_read_tokens).toBe(20);
    expect(rows[1].output_tokens).toBe(40);
  });

  it('skips a Codex token_count with no timestamp, but still advances the baseline past it', () => {
    const noTimestamp = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 0, total_tokens: 130 } } },
    });
    const file = writeTranscript('cx5', [
      turnContext('2026-08-10T08:00:00.000Z', 'gpt-5.6-sol'),
      noTimestamp,
      tokenCount('2026-08-10T09:00:00.000Z', 150, 30, 50),
    ]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'codex', role: '', transcriptPath: file }] });
    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(1);
    const row = d.prepare('SELECT * FROM usage_turns').get() as any;
    expect(row.input_tokens).toBe(40); // (150-100) - (30-20)
    expect(row.cache_read_tokens).toBe(10);
    expect(row.output_tokens).toBe(20);
  });

  // A subagent fork (thread_source: "subagent") inherits its parent's running total and can
  // emit token_count events BEFORE its own first turn_context — verified against a real sampled
  // file: six token_count events, the first already at 192,605 input tokens, before the first
  // turn_context at line 63. That inherited figure is the PARENT's usage, not this thread's, so
  // it must never become a row — and it must never become part of the baseline for a later diff
  // either, or the first real diff would absorb the whole inherited total as one bogus row.
  it('skips token_count events before the first turn_context, and does not let the pre-turn_context total leak into the next diff', () => {
    const file = writeTranscript('cx6', [
      tokenCount('2026-08-10T09:00:00.000Z', 192605, 50000, 8000), // inherited parent total — no turn_context yet
      turnContext('2026-08-10T09:00:01.000Z', 'gpt-5.6-sol'),
      tokenCount('2026-08-10T09:00:02.000Z', 192705, 50000, 8010), // this thread's first real usage: +100 input, +0 cached, +10 output
    ]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'codex', role: '', transcriptPath: file }] });
    expect(res.imported).toBe(1);
    const rows = d.prepare('SELECT * FROM usage_turns').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe('gpt-5.6-sol');
    // Diffs from the pre-turn_context baseline (192605/50000/8000), NOT from zero — a diff from
    // zero would wrongly import the whole 192,605-token inherited total as this row's usage.
    expect(rows[0].input_tokens).toBe(100);
    expect(rows[0].cache_read_tokens).toBe(0);
    expect(rows[0].output_tokens).toBe(10);
  });

  it('imports zero rows for a Codex transcript with token_count events but no turn_context anywhere', () => {
    const file = writeTranscript('cx7', [
      tokenCount('2026-08-10T09:00:00.000Z', 100, 20, 30),
      tokenCount('2026-08-10T09:00:01.000Z', 200, 40, 60),
    ]);
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'codex', role: '', transcriptPath: file }] });
    expect(res.imported).toBe(0);
    expect(res.threads).toBe(0);
    const rows = d.prepare('SELECT * FROM usage_turns').all() as any[];
    expect(rows.length).toBe(0);
  });

  it('imports zero rows for a zero-byte Codex transcript', () => {
    const file = path.join(dir, 'cx8.jsonl');
    fs.writeFileSync(file, '');
    const res = importHistory(d, { cutoff: CUTOFF, threads: [{ terminalId: 'term1', projectId: 'proj1', provider: 'codex', role: '', transcriptPath: file }] });
    expect(res.imported).toBe(0);
    expect(res.threads).toBe(0);
  });
});

describe('clearStaleImportState', () => {
  let d: Database.Database;

  beforeEach(() => {
    d = new Database(':memory:');
    initSchema(d);
  });

  it('turns a persisted running state into error', () => {
    writeBackfillState(d, { state: 'running', done: 3, total: 10, lastFinishedAt: null });
    const changed = clearStaleImportState(d);
    expect(changed).toBe(true);
    const state = readBackfillState(d);
    expect(state.state).toBe('error');
    expect(state.error).toBe('interrupted by a restart');
  });

  it('leaves an idle or done state untouched, and returns false', () => {
    writeBackfillState(d, { state: 'idle', done: 0, total: 0, lastFinishedAt: null });
    expect(clearStaleImportState(d)).toBe(false);
    expect(readBackfillState(d).state).toBe('idle');

    writeBackfillState(d, { state: 'done', done: 5, total: 5, lastFinishedAt: '2026-08-14T00:00:00.000Z' });
    expect(clearStaleImportState(d)).toBe(false);
    const done = readBackfillState(d);
    expect(done.state).toBe('done');
    expect(done.lastFinishedAt).toBe('2026-08-14T00:00:00.000Z');
  });
});
