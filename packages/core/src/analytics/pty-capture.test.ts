import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSchema } from '../db/schema.js';
import * as terminals from '../db/terminals.js';
import * as sessions from '../db/sessions.js';
import { attachPtyCapture } from './pty-capture.js';
import { StatusService } from '../status/service.js';

const fixture = vi.hoisted(() => ({ file: '', codex: { model: 'gpt-test', totals: { input: 100, output: 10, cached: 20 } } }));
vi.mock('../sessions/transcript-path.js', () => ({ resolveTranscriptPath: () => fixture.file || undefined }));
vi.mock('./codex-locate.js', () => ({ locateCodexTranscript: () => fixture.file || undefined }));
vi.mock('./codex-frames.js', () => ({ readCodexTail: () => fixture.codex }));

let db: Database.Database;
let dir: string;
let structured: boolean;
let at: string;
let status: StatusService;
const frame = (id: string, model: string, input = 10) => JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: input, output_tokens: 2 }, content: [] } }) + '\n';
const rows = () => db.prepare('SELECT * FROM usage_turns').all() as any[];

beforeEach(() => {
  db = new Database(':memory:'); initSchema(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-pty-'));
  fixture.file = path.join(dir, 'transcript.jsonl'); fs.writeFileSync(fixture.file, frame('old', 'old-model', 1000));
  fixture.codex = { model: 'gpt-test', totals: { input: 100, output: 10, cached: 20 } };
  at = '2026-09-18T10:00:00Z'; structured = false;
  sessions.create(db, { id: 'p', provider: 'claude-code', name: 'P', workingDir: dir });
  terminals.create(db, { id: 't', sessionId: 'p', type: 'claude-code', label: 'T', externalId: 's' });
  status = new StatusService(db, { broadcast: vi.fn() });
  status.addTurnBoundaryListener(attachPtyCapture({ db, isStructured: () => structured, now: () => at }));
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const start = () => status.ingest('claude', 't', { hook_event_name: 'UserPromptSubmit', session_id: 's' });
const end = () => { at = '2026-09-18T10:00:30Z'; status.ingest('claude', 't', { hook_event_name: 'Stop', session_id: 's' }); };

describe('PTY authoritative turn capture', () => {
  it('captures the first turn while excluding pre-existing history', () => {
    start(); fs.appendFileSync(fixture.file, frame('new', 'claude-sonnet-5')); end();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ input_tokens: 10, output_tokens: 2, coverage: 'reported', transport: 'pty' });
    expect(rows()[0].duration_ms).toBeCloseTo(30000, 0);
  });
  it('captures even if a timing loop already changed display status to waiting', () => {
    start(); fs.appendFileSync(fixture.file, frame('new', 'claude-sonnet-5'));
    terminals.updateStatus(db, 't', 'waiting'); end();
    expect(rows()[0].input_tokens).toBe(10);
  });
  it('permission pauses neither close the turn nor reset its baseline', () => {
    start(); fs.appendFileSync(fixture.file, frame('a', 'claude-sonnet-5'));
    status.ingest('claude', 't', { hook_event_name: 'PermissionRequest', tool_name: 'Write' });
    expect(rows()[0].ended_at).toBeNull();
    status.markWorking('t'); fs.appendFileSync(fixture.file, frame('b', 'claude-opus-5')); end();
    expect(rows()).toHaveLength(1); expect(rows()[0].input_tokens).toBe(20);
    expect(db.prepare('SELECT DISTINCT model FROM usage_facts').all()).toHaveLength(2);
  });
  it('deduplicates native response IDs and duplicate completion hooks', () => {
    start(); const line = frame('repeat', 'claude-sonnet-5'); fs.appendFileSync(fixture.file, line + line); end(); end();
    expect(rows()).toHaveLength(1); expect(rows()[0].input_tokens).toBe(10);
  });
  it('does not invent a turn from SessionStart or an idle notification', () => {
    status.ingest('claude', 't', { hook_event_name: 'SessionStart' });
    status.ingest('claude', 't', { hook_event_name: 'Notification', notification_type: 'idle_prompt' });
    expect(rows()).toEqual([]);
  });
  it('records unsupported transport coverage', () => {
    db.prepare("UPDATE terminals SET type='grok' WHERE id='t'").run();
    status.ingest('grok', 't', { hook_event_name: 'UserPromptSubmit' });
    status.ingest('grok', 't', { hook_event_name: 'Idle' });
    expect(rows()[0]).toMatchObject({ coverage: 'unsupported', input_tokens: 0 });
  });
  it('marks an unavailable or relocated transcript partial', () => {
    start(); fixture.file = path.join(dir, 'other.jsonl'); fs.writeFileSync(fixture.file, frame('old2', 'old', 500)); end();
    expect(rows()[0]).toMatchObject({ coverage: 'partial', input_tokens: 0 });
  });
  it('never re-counts a truncated transcript', () => {
    start(); fs.writeFileSync(fixture.file, '{}\n'); end();
    expect(rows()[0]).toMatchObject({ coverage: 'partial', input_tokens: 0 });
  });
  it('leaves structured recording to the shared live recorder', () => {
    structured = true; start(); end(); expect(rows()).toEqual([]);
  });
  it('closes a process failure as an error', () => {
    start(); fs.appendFileSync(fixture.file, frame('before-crash', 'claude-sonnet-5')); status.markExited('t', 1);
    expect(rows()[0]).toMatchObject({ outcome: 'error', input_tokens: 10 });
  });
  it('records Codex transcript increments with honest model coverage', () => {
    db.prepare("UPDATE terminals SET type='codex' WHERE id='t'").run();
    status.markWorking('t');
    fixture.codex.totals = { input: 160, output: 20, cached: 40 };
    status.ingest('codex', 't', { type: 'agent-turn-complete', 'turn-id': 'c1' });
    expect(rows()[0]).toMatchObject({ input_tokens: 40, output_tokens: 10, cache_read_tokens: 20, coverage: 'partial' });
  });
  it('keeps Codex counter resets out of token totals', () => {
    db.prepare("UPDATE terminals SET type='codex' WHERE id='t'").run(); status.markWorking('t');
    fixture.codex.totals = { input: 5, output: 1, cached: 0 };
    status.ingest('codex', 't', { type: 'agent-turn-complete' });
    expect(rows()[0]).toMatchObject({ input_tokens: 0, coverage: 'partial' });
  });
  it('records a fresh Codex session whose transcript appears during the first turn', () => {
    db.prepare("UPDATE terminals SET type='codex', external_id=NULL WHERE id='t'").run();
    const file = fixture.file; fixture.file = '';
    status.markWorking('t'); fixture.file = file;
    status.ingest('codex', 't', { type: 'agent-turn-complete', 'thread-id': 'fresh' });
    expect(rows()[0]).toMatchObject({ input_tokens: 80, output_tokens: 10, cache_read_tokens: 20, coverage: 'partial' });
  });
  it('marks a partially written final transcript frame as partial coverage', () => {
    start(); fs.appendFileSync(fixture.file, frame('complete', 'claude-sonnet-5') + '{"type":'); end();
    expect(rows()[0]).toMatchObject({ input_tokens: 10, coverage: 'partial' });
  });

});
