import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as terminalsDb from '../db/terminals.js';
import * as sessionsDb from '../db/sessions.js';
import * as ptyDb from '../db/usage-pty.js';
import { clearTranscriptPathCache } from '../sessions/transcript-path.js';
import { encodeClaudeProjectDir } from '../platform/encode.js';
import { attachPtyCapture, type PtyCaptureDeps } from './pty-capture.js';

function claudeLine(model: string, output: number) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model,
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
    },
  });
}

function codexTokenCount(input: number, cached: number, output: number) {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input, cached_input_tokens: cached,
          output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
        },
        last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
      },
    },
  });
}

function codexTurnContext(model: string) {
  return JSON.stringify({ type: 'turn_context', payload: { model } });
}

describe('attachPtyCapture', () => {
  let db: Database.Database;
  let home: string;
  let origHome: string | undefined;
  let sessionId: string;
  let clock: string;

  const now = () => clock;
  const deps = (overrides: Partial<PtyCaptureDeps> = {}): PtyCaptureDeps => ({
    db, isStructured: () => false, now, ...overrides,
  });

  const makeTerminal = (type: string, externalId: string, workingDir?: string): string => {
    const id = `term-${Math.random().toString(36).slice(2)}`;
    terminalsDb.create(db, {
      id, sessionId, type, label: 'x', externalId, workingDir,
    });
    return id;
  };

  const rows = () => db.prepare('SELECT * FROM usage_turns').all() as any[];

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    sessionId = 'sess-1';
    sessionsDb.create(db, { id: sessionId, provider: 'claude-code', name: 'x', workingDir: '' });

    origHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-capture-'));
    process.env.HOME = home;
    clearTranscriptPathCache();
    clock = '2026-08-14T10:00:00.000Z';
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function claudeTranscriptPath(workDir: string, id: string): string {
    return path.join(home, '.claude', 'projects', encodeClaudeProjectDir(workDir, 'darwin'), `${id}.jsonl`);
  }

  function writeClaudeTranscript(workDir: string, id: string, content: string): string {
    const file = claudeTranscriptPath(workDir, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  function codexTranscriptPath(id: string): string {
    return path.join(home, '.codex', 'sessions', `rollout-2026-08-14T09-00-00-${id}.jsonl`);
  }

  function writeCodexTranscript(id: string, content: string): string {
    const file = codexTranscriptPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  // The double-count gate. This is the most important test in the plan.
  it('writes NOTHING for a structured terminal', () => {
    const workDir = path.join(home, 'proj-a');
    const extId = 'sess-a';
    writeClaudeTranscript(workDir, extId, claudeLine('claude-opus-5', 20) + '\n');
    const termId = makeTerminal('claude-code', extId, workDir);

    const listener = attachPtyCapture(deps({ isStructured: () => true }));
    listener({ terminalId: termId, sessionId, threadStatus: 'idle' });

    expect(rows().length).toBe(0);
    expect(ptyDb.getState(db, termId)).toBeNull();
  });

  it('writes no row on first sight, and records the end position', () => {
    const workDir = path.join(home, 'proj-b');
    const extId = 'sess-b';
    const file = writeClaudeTranscript(workDir, extId, claudeLine('claude-opus-5', 20) + '\n');
    const termId = makeTerminal('claude-code', extId, workDir);

    const listener = attachPtyCapture(deps());
    listener({ terminalId: termId, sessionId, threadStatus: 'idle' });

    expect(rows().length).toBe(0);
    const state = ptyDb.getState(db, termId);
    expect(state).not.toBeNull();
    expect(state!.transcript_path).toBe(file);
    expect(state!.byte_offset).toBe(fs.statSync(file).size);
  });

  it('writes one row on the second settle, covering only the new bytes (claude-code)', () => {
    const workDir = path.join(home, 'proj-c');
    const extId = 'sess-c';
    const file = writeClaudeTranscript(workDir, extId, claudeLine('claude-opus-5', 20) + '\n');
    const termId = makeTerminal('claude-code', extId, workDir);

    const listener = attachPtyCapture(deps());
    listener({ terminalId: termId, sessionId, threadStatus: 'idle' }); // bootstrap, no row

    fs.appendFileSync(file, claudeLine('claude-opus-5', 7) + '\n');
    clock = '2026-08-14T10:05:00.000Z';
    listener({ terminalId: termId, sessionId, threadStatus: 'idle' });

    const all = rows();
    expect(all.length).toBe(1);
    expect(all[0].output_tokens).toBe(7); // only the new message, not 20 + 7
    expect(all[0].input_tokens).toBe(10);
    expect(all[0].cache_read_tokens).toBe(5);
    expect(all[0].cache_create_tokens).toBe(1);
    expect(all[0].model).toBe('claude-opus-5');
    expect(all[0].started_at).toBe('2026-08-14T10:00:00.000Z');
    expect(all[0].ended_at).toBe('2026-08-14T10:05:00.000Z');
    expect(all[0].outcome).toBe('idle');
    expect(all[0].provider).toBe('claude-code');
    expect(all[0].project_id).toBe(sessionId);

    const state = ptyDb.getState(db, termId)!;
    expect(state.byte_offset).toBe(fs.statSync(file).size);
  });

  it('writes needs_help outcome when the thread settles needing input', () => {
    const workDir = path.join(home, 'proj-c2');
    const extId = 'sess-c2';
    const file = writeClaudeTranscript(workDir, extId, claudeLine('claude-opus-5', 20) + '\n');
    const termId = makeTerminal('claude-code', extId, workDir);

    const listener = attachPtyCapture(deps());
    listener({ terminalId: termId, sessionId, threadStatus: 'idle' }); // bootstrap

    fs.appendFileSync(file, claudeLine('claude-opus-5', 3) + '\n');
    listener({ terminalId: termId, sessionId, threadStatus: 'needs_input' });

    expect(rows()[0].outcome).toBe('needs_help');
  });

  it('diffs the running total for a codex terminal', () => {
    const extId = 'codex-a';
    const file = writeCodexTranscript(extId, codexTurnContext('gpt-5.6-sol') + '\n' + codexTokenCount(100, 10, 50) + '\n');
    const termId = makeTerminal('codex', extId);

    const listener = attachPtyCapture(deps());
    listener({ terminalId: termId, sessionId, threadStatus: 'idle' }); // bootstrap at 100/10/50
    expect(rows().length).toBe(0);

    fs.appendFileSync(file, '\n' + codexTokenCount(140, 25, 70) + '\n');
    clock = '2026-08-14T10:10:00.000Z';
    listener({ terminalId: termId, sessionId, threadStatus: 'idle' });

    const all = rows();
    expect(all.length).toBe(1);
    // dInput=40, dCached=15, dOutput=20 -> input = dInput - dCached = 25
    expect(all[0].input_tokens).toBe(25);
    expect(all[0].cache_read_tokens).toBe(15);
    expect(all[0].output_tokens).toBe(20);
    expect(all[0].cache_create_tokens).toBe(0);
    expect(all[0].provider).toBe('codex');
    expect(all[0].model).toBe('gpt-5.6-sol');

    const state = ptyDb.getState(db, termId)!;
    expect(state.last_total_input).toBe(140);
    expect(state.last_total_cached).toBe(25);
    expect(state.last_total_output).toBe(70);
  });

  it('records zero and resets when a codex total goes backwards', () => {
    const extId = 'codex-b';
    const file = writeCodexTranscript(extId, codexTokenCount(500, 100, 300) + '\n');
    const termId = makeTerminal('codex', extId);

    const listener = attachPtyCapture(deps());
    listener({ terminalId: termId, sessionId, threadStatus: 'idle' }); // bootstrap at 500/100/300

    fs.appendFileSync(file, '\n' + codexTokenCount(20, 5, 10) + '\n'); // went backwards
    listener({ terminalId: termId, sessionId, threadStatus: 'idle' });

    const all = rows();
    expect(all.length).toBe(1);
    expect(all[0].input_tokens).toBe(0);
    expect(all[0].output_tokens).toBe(0);
    expect(all[0].cache_read_tokens).toBe(0);
    expect(all[0].cache_create_tokens).toBe(0);

    const state = ptyDb.getState(db, termId)!;
    expect(state.last_total_input).toBe(20);
    expect(state.last_total_cached).toBe(5);
    expect(state.last_total_output).toBe(10);
  });

  it('starts fresh when a claude transcript path changes (relocation)', () => {
    const oldWorkDir = path.join(home, 'proj-old');
    const newWorkDir = path.join(home, 'proj-new');
    const extId = 'sess-reloc';
    const oldFile = writeClaudeTranscript(oldWorkDir, extId, claudeLine('claude-opus-5', 20) + '\n');
    // The terminal's stored working_dir never updates on relocation (see
    // sessions/transcript-path.ts) — it still points at the OLD directory.
    const termId = makeTerminal('claude-code', extId, oldWorkDir);

    const listener = attachPtyCapture(deps());
    listener({ terminalId: termId, sessionId, threadStatus: 'idle' }); // bootstrap at oldFile
    expect(ptyDb.getState(db, termId)!.transcript_path).toBe(oldFile);

    // The session relocates: the transcript now lives under a different project
    // dir entirely (the file no longer exists at the encoded old working_dir).
    const newFile = claudeTranscriptPath(newWorkDir, extId);
    fs.mkdirSync(path.dirname(newFile), { recursive: true });
    fs.renameSync(oldFile, newFile);
    fs.appendFileSync(newFile, claudeLine('claude-opus-5', 99) + '\n'); // more "history" at the new path

    listener({ terminalId: termId, sessionId, threadStatus: 'idle' });

    expect(rows().length).toBe(0); // no row — a byte offset from another file is meaningless
    const state = ptyDb.getState(db, termId)!;
    expect(state.transcript_path).toBe(newFile);
    expect(state.byte_offset).toBe(fs.statSync(newFile).size);
  });

  it('writes nothing for a grok terminal', () => {
    const termId = makeTerminal('grok', 'grok-ext-1');

    const listener = attachPtyCapture(deps());
    listener({ terminalId: termId, sessionId, threadStatus: 'idle' });

    expect(rows().length).toBe(0);
    expect(ptyDb.getState(db, termId)).toBeNull();
  });

  it('never throws when the transcript is missing', () => {
    const termId = makeTerminal('claude-code', 'no-such-session', path.join(home, 'nowhere'));
    const codexTermId = makeTerminal('codex', 'no-such-codex-session');

    const listener = attachPtyCapture(deps());
    expect(() => listener({ terminalId: termId, sessionId, threadStatus: 'idle' })).not.toThrow();
    expect(() => listener({ terminalId: codexTermId, sessionId, threadStatus: 'idle' })).not.toThrow();

    expect(rows().length).toBe(0);
  });
});
