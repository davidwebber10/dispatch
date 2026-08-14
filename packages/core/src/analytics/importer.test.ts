import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { importHistory } from './importer.js';

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
});
