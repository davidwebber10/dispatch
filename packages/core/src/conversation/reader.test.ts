import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import * as messageSourceDb from '../db/message-source.js';
import { parseClaudeTranscript, type ConvItem } from './transcript.js';
import { parseCodexRollout } from './codex-transcript.js';
import { ConversationReader, type ConvPage } from './reader.js';
import { LineIndex } from './line-index.js';

type PageOpts = { since?: number; before?: number; beforeUuid?: string; limit?: number };
type ParseLine = (line: string) => ConvItem[];

// ───────────────────────────── the oracle ─────────────────────────────
// The windowing code of SessionService.getConversation and searchConversation as it was before
// W2-B (commit 84462357, sessions/service.ts:1108-1163 and :1180-1192), copied here unchanged
// except that the file content comes in as `usable` (= raw.split('\n').slice(0, -1)) and the
// source-tag lookup is a parameter. The new reader must give the same answer.

function oldUsable(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);
}

function oldPage(
  usable: string[],
  parseLine: ParseLine,
  opts: PageOpts = {},
  sources: (uuids: string[]) => Map<string, 'user' | 'coordinator'> = () => new Map(),
): ConvPage {
  const total = usable.length;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 200;

  let beforeFromUuid: number | undefined;
  if (opts.beforeUuid) {
    for (let i = total - 1; i >= 0; i--) {
      try { if (JSON.parse(usable[i])?.uuid === opts.beforeUuid) { beforeFromUuid = i; break; } } catch { /* partial/garbled line */ }
    }
  }

  let start: number;
  let end: number;
  if (beforeFromUuid !== undefined) {
    end = beforeFromUuid;
    start = Math.max(0, end - limit);
  } else if (opts.before !== undefined && opts.before > 0) {
    end = Math.min(opts.before, total);
    start = Math.max(0, end - limit);
  } else if (opts.since !== undefined && opts.since > 0) {
    start = Math.min(opts.since, total);
    end = total;
  } else {
    end = total;
    start = Math.max(0, total - limit);
  }

  const items: ConvItem[] = [];
  for (let i = start; i < end; i++) {
    for (const it of parseLine(usable[i])) items.push({ ...it, line: i });
  }
  const userUuids = items.filter((it) => it.kind === 'user' && it.uuid).map((it) => it.uuid as string);
  if (userUuids.length) {
    const sourceByUuid = sources(userUuids);
    if (sourceByUuid.size) {
      for (const it of items) {
        if (it.kind === 'user' && it.uuid && sourceByUuid.has(it.uuid)) it.source = sourceByUuid.get(it.uuid);
      }
    }
  }
  return { items, cursor: total, startLine: start, hasMore: start > 0 };
}

function oldSnippetAround(text: string, at: number, matchLen: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const idx = flat.toLowerCase().indexOf(text.slice(at, at + matchLen).replace(/\s+/g, ' ').trim().toLowerCase());
  const start = Math.max(0, (idx < 0 ? 0 : idx) - 30);
  const end = Math.min(flat.length, (idx < 0 ? 0 : idx) + matchLen + 50);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

function oldSearch(usable: string[], query: string, limit = 200): { matches: { line: number; kind: string; snippet: string }[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { matches: [] };
  const matches: { line: number; kind: string; snippet: string }[] = [];
  for (let i = usable.length - 1; i >= 0 && matches.length < limit; i--) {
    for (const it of parseClaudeTranscript(usable[i])) {
      const hay = `${it.text ?? ''} ${it.toolTitle ?? ''} ${it.toolDetail ?? ''}`;
      const at = hay.toLowerCase().indexOf(q);
      if (at >= 0) {
        matches.push({ line: i, kind: it.kind, snippet: oldSnippetAround(hay, at, q.length) });
        break;
      }
    }
  }
  return { matches };
}

// ───────────────────────────── fixtures ─────────────────────────────

const iso = (i: number) => new Date(1_760_000_000_000 + i * 1000).toISOString();

/** The line shapes that Claude Code writes, in rotation. `i` makes each line distinct. */
function claudeLine(i: number, pad = ''): string {
  const parentUuid = i > 0 ? `uuid-${i - 1}` : null;
  switch (i % 8) {
    case 0: return JSON.stringify({ type: 'user', uuid: `uuid-${i}`, parentUuid, timestamp: iso(i), message: { role: 'user', content: `Question ${i}: where is the needle${i}? ${pad}` } });
    case 1: return JSON.stringify({ type: 'assistant', uuid: `uuid-${i}`, parentUuid, timestamp: iso(i), message: { role: 'assistant', content: [{ type: 'thinking', thinking: `Thought ${i}` }, { type: 'text', text: `Answer ${i} — héllo 日本語 🎉 ${pad}` }] } });
    case 2: return JSON.stringify({ type: 'assistant', uuid: `uuid-${i}`, parentUuid, timestamp: iso(i), message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${i}`, name: 'Bash', input: { command: `ls -la /tmp/dir-${i}`, description: `List ${i}` } }] } });
    case 3: return JSON.stringify({ type: 'user', uuid: `uuid-${i}`, parentUuid, timestamp: iso(i), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${i - 1}`, content: `total ${i}\nfile-a\nfile-b ${pad}` }] } });
    case 4: return JSON.stringify({ type: 'user', isMeta: true, uuid: `uuid-${i}`, parentUuid, timestamp: iso(i), message: { role: 'user', content: 'injected context' } });
    case 5: return JSON.stringify({ type: 'file-history-snapshot', messageId: `m-${i}`, snapshot: { trackedFileBackups: {} } });
    case 6: return JSON.stringify({ type: 'user', uuid: `uuid-${i}`, parentUuid, timestamp: iso(i), message: { role: 'user', content: [{ type: 'text', text: `Follow-up ${i}\r\nwith a second line ${pad}` }] } });
    default: return JSON.stringify({ type: 'assistant', uuid: `uuid-${i}`, parentUuid, timestamp: iso(i), message: { role: 'assistant', content: [{ type: 'text', text: `Final ${i}. ${pad}` }, { type: 'tool_use', id: `tool-${i}`, name: 'Read', input: { file_path: `/src/file-${i}.ts` } }] } });
  }
}

/** A Claude transcript with a garbled line, an empty line, a CRLF line, a `null` line and a half-written last line. */
function claudeFixture(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    if (i === 17) out.push('{"type":"user","message":{"role":"user","content":"cut off');
    else if (i === 23) out.push('');
    else if (i === 29) out.push('null');
    else if (i === 31) out.push(claudeLine(i) + '\r');
    else out.push(claudeLine(i));
  }
  return out.join('\n') + '\n' + '{"type":"assistant","uuid":"half-written","message":{"content":[{"type":"te';
}

function codexLine(i: number): string {
  const timestamp = iso(i);
  switch (i % 6) {
    case 0: return JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Codex question ${i}` }] } });
    case 1: return JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Codex answer ${i} — ünïcode` }] } });
    case 2: return JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'agent_message', message: `duplicate ${i}` } });
    case 3: return JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['ls', `/d${i}`] }), call_id: `call-${i}` } });
    case 4: return JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'function_call_output', call_id: `call-${i - 1}`, output: JSON.stringify({ output: `out ${i}`, metadata: { exit_code: 0 } }) } });
    default: return JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: `Reasoning ${i}` }] } });
  }
}

function codexFixture(lines: number): string {
  const out = [JSON.stringify({ timestamp: iso(0), type: 'session_meta', payload: { id: 'sess', cwd: '/proj' } })];
  for (let i = 1; i < lines; i++) out.push(codexLine(i));
  return out.join('\n') + '\n';
}

// ───────────────────────────── harness ─────────────────────────────

let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-conv-reader-'));
  db = new Database(':memory:');
  initSchema(db);
  LineIndex.clearCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  LineIndex.clearCache();
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function readerFor(file: string, parseLine: ParseLine = parseClaudeTranscript, database: Database.Database = db): ConversationReader {
  return new ConversationReader({ db: database, locate: () => ({ file, parseLine }) });
}

function write(name: string, content: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, content);
  return file;
}

/** Byte-identical: the JSON text of the two answers is equal (key order included). */
function expectSame(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

/** Every option set that the four window rules can see, for a file of `total` lines. */
function windowCases(total: number, uuids: string[]): PageOpts[] {
  const cases: PageOpts[] = [
    {}, { limit: 1 }, { limit: 7 }, { limit: 200 }, { limit: total }, { limit: total + 50 }, { limit: 0 }, { limit: -3 },
    { before: 0 }, { before: 1 }, { before: 5, limit: 3 }, { before: 5, limit: 50 }, { before: total }, { before: total + 100, limit: 10 },
    { before: Math.floor(total / 2), limit: 20 }, { before: -4, limit: 5 },
    { since: 0 }, { since: 1 }, { since: total - 1 }, { since: total }, { since: total + 9 }, { since: Math.floor(total / 2) }, { since: -1 },
    { since: 3, limit: 2 }, { before: 9, since: 2, limit: 4 },
    { beforeUuid: 'does-not-exist' }, { beforeUuid: 'does-not-exist', before: 12, limit: 5 }, { beforeUuid: 'does-not-exist', since: 4 },
    { beforeUuid: '' },
  ];
  for (const uuid of uuids) cases.push({ beforeUuid: uuid }, { beforeUuid: uuid, limit: 4 }, { beforeUuid: uuid, before: 3, since: 2, limit: 6 });
  return cases;
}

describe('ConversationReader.page', () => {
  it('parity: for the fixture transcript, each of the four window modes returns the same result as the old synchronous code', async () => {
    const file = write('claude.jsonl', claudeFixture(260));
    const usable = oldUsable(file);
    expect(usable.length).toBe(260); // the half-written last line is not a line
    const reader = readerFor(file);
    for (const opts of windowCases(usable.length, ['uuid-0', 'uuid-1', 'uuid-128', 'uuid-259', 'half-written', 'uuid-5', 'tool-2'])) {
      expectSame(await reader.page('t', opts), oldPage(usable, parseClaudeTranscript, opts));
    }
  });

  it('parity for a Codex rollout fixture', async () => {
    const file = write('rollout.jsonl', codexFixture(240));
    const usable = oldUsable(file);
    const reader = readerFor(file, parseCodexRollout);
    for (const opts of windowCases(usable.length, ['sess'])) {
      expectSame(await reader.page('t', opts), oldPage(usable, parseCodexRollout, opts));
    }
    const page = await reader.page('t', { limit: 12 });
    expect(page.items.map((it) => it.kind)).toContain('tool');
    expect(page.items.every((it) => typeof it.line === 'number')).toBe(true);
  });

  it('parity: every page of a walk upward, and of a walk downward', async () => {
    const file = write('claude.jsonl', claudeFixture(1000));
    const usable = oldUsable(file);
    const reader = readerFor(file);

    let before: number | undefined;
    let pages = 0;
    for (;;) {
      const opts = { before, limit: 37 };
      const page = await reader.page('t', opts);
      expectSame(page, oldPage(usable, parseClaudeTranscript, opts));
      pages++;
      if (!page.hasMore) break;
      before = page.startLine;
    }
    expect(pages).toBe(Math.ceil(1000 / 37));

    for (let since = 1; since < 1000; since += 111) {
      expectSame(await reader.page('t', { since }), oldPage(usable, parseClaudeTranscript, { since }));
    }
  });

  it('beforeUuid finds an anchor that sits 300 KB before the end', async () => {
    const pad = 'x'.repeat(1500);
    const lines = Array.from({ length: 600 }, (_, i) => claudeLine(i, pad));
    const file = write('claude.jsonl', lines.join('\n') + '\n');
    const size = fs.statSync(file).size;
    // The first line whose distance from the end of the file is 300 KB or more.
    let anchor = lines.length - 1;
    for (let tail = 0; anchor > 0; anchor--) {
      tail += Buffer.byteLength(lines[anchor]) + 1;
      if (tail >= 300 * 1024 && anchor % 8 === 0) break;
    }
    expect(size - Buffer.byteLength(lines.slice(0, anchor).join('\n'))).toBeGreaterThan(300 * 1024);

    const usable = oldUsable(file);
    const reader = readerFor(file);
    const opts = { beforeUuid: `uuid-${anchor}`, limit: 25 };
    const page = await reader.page('t', opts);
    expect(page.startLine).toBe(anchor - 25);
    expect(page.items.every((it) => (it.line as number) < anchor)).toBe(true);
    expectSame(page, oldPage(usable, parseClaudeTranscript, opts));
  });

  it('beforeUuid matches the uuid of the line only (not a parentUuid), and takes the newest of two equal uuids', async () => {
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'a', message: { role: 'user', content: 'one' } }),
      JSON.stringify({ type: 'user', uuid: 'dup', message: { role: 'user', content: 'two' } }),
      JSON.stringify({ type: 'user', uuid: 'c', parentUuid: 'only-a-parent', message: { role: 'user', content: 'three says only-a-parent' } }),
      JSON.stringify({ type: 'user', uuid: 'dup', message: { role: 'user', content: 'four' } }),
      JSON.stringify({ type: 'user', uuid: 'we"ird\\uuid é', message: { role: 'user', content: 'five' } }),
      JSON.stringify({ type: 'user', uuid: 'f', message: { role: 'user', content: 'six' } }),
    ];
    const file = write('claude.jsonl', lines.join('\n') + '\n');
    const usable = oldUsable(file);
    const reader = readerFor(file);
    for (const beforeUuid of ['only-a-parent', 'dup', 'we"ird\\uuid é', 'a', 'f', 'three']) {
      expectSame(await reader.page('t', { beforeUuid }), oldPage(usable, parseClaudeTranscript, { beforeUuid }));
    }
    expect((await reader.page('t', { beforeUuid: 'dup' })).items.map((it) => it.text)).toEqual(['one', 'two', 'three says only-a-parent']);
    expect((await reader.page('t', { beforeUuid: 'only-a-parent' })).items).toHaveLength(6); // not found: the newest window
  });

  it('page never calls fs.readFileSync', async () => {
    const file = write('claude.jsonl', claudeFixture(300));
    const reader = readerFor(file);
    const spy = vi.spyOn(fs, 'readFileSync');
    await reader.page('t', {});
    await reader.page('t', { before: 100, limit: 20 });
    await reader.page('t', { since: 250 });
    await reader.page('t', { beforeUuid: 'uuid-40' });
    await reader.search('t', 'needle');
    expect(spy).not.toHaveBeenCalled();
  });

  it('a thread with no transcript returns the empty page', async () => {
    const empty = { items: [], cursor: 0, startLine: 0, hasMore: false };
    const none = new ConversationReader({ db, locate: () => null });
    expect(await none.page('t', {})).toEqual(empty);
    expect('unsupported' in (await none.page('t', {}))).toBe(false);

    const missing = readerFor(path.join(tmp, 'absent.jsonl'));
    expect(await missing.page('t', { limit: 10 })).toEqual(empty);
    expect(await missing.search('t', 'x')).toEqual({ matches: [] });

    const blank = readerFor(write('blank.jsonl', ''));
    expect(await blank.page('t', {})).toEqual(empty);
    const half = readerFor(write('half.jsonl', '{"type":"user","message":{"role":"user","content":"no newline yet"}}'));
    expect(await half.page('t', {})).toEqual(empty);
  });

  it('a shell thread returns unsupported', async () => {
    const reader = new ConversationReader({ db, locate: () => 'unsupported' });
    const page = await reader.page('sh', { limit: 10 });
    expect(JSON.stringify(page)).toBe('{"items":[],"cursor":0,"startLine":0,"hasMore":false,"unsupported":true}');
    expect(await reader.search('sh', 'x')).toEqual({ matches: [] });
  });

  it('merges the stored source tag onto user turns, as the old code did', async () => {
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'p', workingDir: '/proj' });
    terminalsDb.create(db, { id: 'term', sessionId: 's1', type: 'claude-code', label: 't' });
    const file = write('claude.jsonl', claudeFixture(64));
    messageSourceDb.record(db, 'term', 'uuid-0', 'coordinator');
    messageSourceDb.record(db, 'term', 'uuid-8', 'user');
    messageSourceDb.record(db, 'term', 'uuid-1', 'coordinator'); // an assistant line: never tagged
    const usable = oldUsable(file);
    const reader = readerFor(file);
    const page = await reader.page('term', {});
    expectSame(page, oldPage(usable, parseClaudeTranscript, {}, (uuids) => messageSourceDb.getForUuids(db, 'term', uuids)));
    expect(page.items.find((it) => it.uuid === 'uuid-0')?.source).toBe('coordinator');
    expect(page.items.find((it) => it.uuid === 'uuid-8')?.source).toBe('user');
    expect(page.items.filter((it) => it.uuid === 'uuid-1').every((it) => it.source === undefined)).toBe(true);
  });

  it('file growth during paging: older pages do not move and a poll gets the new lines', async () => {
    const file = write('claude.jsonl', Array.from({ length: 300 }, (_, i) => claudeLine(i)).join('\n') + '\n');
    const reader = readerFor(file);
    const first = await reader.page('t', { limit: 50 });
    expect(first).toMatchObject({ cursor: 300, startLine: 250, hasMore: true });

    // The agent writes while the user scrolls up: 40 complete lines and one half-written line.
    fs.appendFileSync(file, Array.from({ length: 40 }, (_, i) => claudeLine(300 + i)).join('\n') + '\n' + '{"type":"assistant","uuid":"pending"');
    let usable = oldUsable(file);
    expect(usable.length).toBe(340);

    const older = await reader.page('t', { before: first.startLine, limit: 50 });
    expectSame(older, oldPage(usable, parseClaudeTranscript, { before: first.startLine, limit: 50 }));
    expect(older).toMatchObject({ cursor: 340, startLine: 200 });

    const poll = await reader.page('t', { since: first.cursor });
    expectSame(poll, oldPage(usable, parseClaudeTranscript, { since: first.cursor }));
    expect(poll.items.every((it) => (it.line as number) >= 300)).toBe(true);
    expect(poll.cursor).toBe(340);

    // The half-written line is completed: it is line 340 now.
    fs.appendFileSync(file, ',"message":{"role":"assistant","content":[{"type":"text","text":"landed"}]}}\n');
    usable = oldUsable(file);
    const next = await reader.page('t', { since: poll.cursor });
    expectSame(next, oldPage(usable, parseClaudeTranscript, { since: poll.cursor }));
    expect(next.items.map((it) => it.text)).toEqual(['landed']);
    expectSame(await reader.page('t', { beforeUuid: 'pending', limit: 3 }), oldPage(usable, parseClaudeTranscript, { beforeUuid: 'pending', limit: 3 }));
  });

  it('truncation between two pages: the next page is that of the new content', async () => {
    const file = write('claude.jsonl', Array.from({ length: 400 }, (_, i) => claudeLine(i)).join('\n') + '\n');
    const reader = readerFor(file);
    expect((await reader.page('t', { limit: 20 })).cursor).toBe(400);

    fs.writeFileSync(file, Array.from({ length: 30 }, (_, i) => claudeLine(1000 + i)).join('\n') + '\n'); // same inode, smaller
    const usable = oldUsable(file);
    for (const opts of [{}, { before: 380, limit: 20 }, { since: 400 }, { beforeUuid: 'uuid-399' }, { beforeUuid: 'uuid-1010', limit: 4 }] as PageOpts[]) {
      expectSame(await reader.page('t', opts), oldPage(usable, parseClaudeTranscript, opts));
    }
  });

  it('rotation between two pages: a new file at the same path is read from its start', async () => {
    const file = write('claude.jsonl', Array.from({ length: 100 }, (_, i) => claudeLine(i)).join('\n') + '\n');
    const reader = readerFor(file);
    expect((await reader.page('t', {})).cursor).toBe(100);

    const next = write('next.jsonl', Array.from({ length: 500 }, (_, i) => claudeLine(5000 + i)).join('\n') + '\n');
    fs.renameSync(next, file); // new inode, larger
    const usable = oldUsable(file);
    for (const opts of [{}, { before: 90, limit: 20 }, { since: 100 }, { beforeUuid: 'uuid-5400', limit: 9 }] as PageOpts[]) {
      expectSame(await reader.page('t', opts), oldPage(usable, parseClaudeTranscript, opts));
    }

    fs.rmSync(file);
    expect(await reader.page('t', {})).toEqual({ items: [], cursor: 0, startLine: 0, hasMore: false });
  });

  it('a file that is cut while a page reads it gives the page of the new content', async () => {
    const file = write('claude.jsonl', Array.from({ length: 400 }, (_, i) => claudeLine(i)).join('\n') + '\n');
    const reader = readerFor(file);
    await reader.page('t', {});

    // Cut the file after the index is refreshed and before the page bytes are read.
    const short = Array.from({ length: 10 }, (_, i) => claudeLine(2000 + i)).join('\n') + '\n';
    const realRefresh = LineIndex.prototype.refresh;
    let cuts = 0;
    vi.spyOn(LineIndex.prototype, 'refresh').mockImplementation(async function (this: LineIndex) {
      await realRefresh.call(this);
      if (cuts++ === 0) fs.writeFileSync(file, short);
    });
    const page = await reader.page('t', { limit: 30 });
    expectSame(page, oldPage(oldUsable(file), parseClaudeTranscript, { limit: 30 }));
    expect(page.cursor).toBe(10);
  });

  it('concurrent pages of one file each get their own window', async () => {
    const file = write('claude.jsonl', claudeFixture(900));
    const usable = oldUsable(file);
    const reader = readerFor(file);
    const all: PageOpts[] = [{}, { before: 500, limit: 60 }, { since: 850 }, { beforeUuid: 'uuid-300', limit: 30 }, { before: 60 }, { limit: 900 }];
    const pages = await Promise.all(all.map((opts) => reader.page('t', opts)));
    pages.forEach((page, i) => expectSame(page, oldPage(usable, parseClaudeTranscript, all[i])));
  });

  it('a page larger than one read group (2.5 MB of lines) is complete and in order', async () => {
    const pad = 'p'.repeat(20_000);
    const file = write('claude.jsonl', Array.from({ length: 130 }, (_, i) => claudeLine(i, pad)).join('\n') + '\n');
    const usable = oldUsable(file);
    const reader = readerFor(file);
    for (const opts of [{}, { since: 1 }, { before: 129, limit: 128 }] as PageOpts[]) {
      expectSame(await reader.page('t', opts), oldPage(usable, parseClaudeTranscript, opts));
    }
  });

  it('a parser error rejects the page (the route answers 500)', async () => {
    const file = write('claude.jsonl', claudeFixture(10));
    const reader = readerFor(file, () => { throw new Error('parser broke'); });
    await expect(reader.page('t', {})).rejects.toThrow('parser broke');
  });
});

describe('ConversationReader.search', () => {
  it('parity with the old synchronous search: newest first, one match for each line, the same snippets', async () => {
    const file = write('claude.jsonl', claudeFixture(700));
    const usable = oldUsable(file);
    const reader = readerFor(file);
    for (const [query, limit] of [['needle', undefined], ['NEEDLE1', undefined], ['  answer  ', 5], ['日本語', 3], ['file-a file-b', undefined], ['ls -la', 1000], ['no such text', undefined], ['', undefined], ['   ', undefined], ['second line', 2]] as [string, number | undefined][]) {
      expectSame(await reader.search('t', query, limit), oldSearch(usable, query, limit));
    }
    const hits = await reader.search('t', 'needle', 4);
    expect(hits.matches).toHaveLength(4);
    expect(hits.matches[0].line).toBeGreaterThan(hits.matches[3].line);
  });

  it('search over a file larger than one read group', async () => {
    const pad = 'w'.repeat(9000);
    const file = write('claude.jsonl', Array.from({ length: 400 }, (_, i) => claudeLine(i, pad)).join('\n') + '\n');
    const usable = oldUsable(file);
    const reader = readerFor(file);
    expectSame(await reader.search('t', 'question 8'), oldSearch(usable, 'question 8'));
    expectSame(await reader.search('t', 'needle', 1000), oldSearch(usable, 'needle', 1000));
  });
});

describe('ConversationReader.tailItems (synchronous, for the two in-process callers)', () => {
  const stripLine = (items: ConvItem[]) => items.map(({ line: _line, ...rest }) => rest);

  it('gives the items of the newest `limit` lines, the same as the old default window', () => {
    const file = write('claude.jsonl', claudeFixture(700));
    const usable = oldUsable(file);
    const reader = readerFor(file);
    for (const limit of [1, 50, 500, 700, 5000]) {
      expect(reader.tailItems('t', limit)).toEqual(stripLine(oldPage(usable, parseClaudeTranscript, { limit }).items));
    }
  });

  it('reads more of the file when the first tail window holds too few lines', () => {
    // 60 lines of 300 KB: 50 lines are 15 MB, more than the first window.
    const pad = 'k'.repeat(300_000);
    const file = write('claude.jsonl', Array.from({ length: 60 }, (_, i) => claudeLine(i, pad)).join('\n') + '\n');
    const usable = oldUsable(file);
    const reader = readerFor(file);
    const spy = vi.spyOn(fs, 'readFileSync');
    const items = reader.tailItems('t', 50);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(items).toEqual(stripLine(oldPage(usable, parseClaudeTranscript, { limit: 50 }).items));
  });

  it('no transcript, an unsupported thread and a missing file give no items', () => {
    expect(new ConversationReader({ db, locate: () => null }).tailItems('t', 50)).toEqual([]);
    expect(new ConversationReader({ db, locate: () => 'unsupported' }).tailItems('t', 50)).toEqual([]);
    expect(readerFor(path.join(tmp, 'absent.jsonl')).tailItems('t', 50)).toEqual([]);
  });
});

// ───────────────────────────── the large file ─────────────────────────────
// Plan 1A.2, "Transcript paging blocks the loop". 100 MB, or 20 MB when CI=1. The file is made in
// a temp dir and removed after.

const LARGE_BYTES = (process.env.CI === '1' ? 20 : 100) * 1024 * 1024;
const BLOCK_LIMIT_MS = 50;

function writeLargeTranscript(file: string, bytes: number): number {
  const fd = fs.openSync(file, 'w');
  const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(40);
  let written = 0;
  let i = 0;
  try {
    while (written < bytes) {
      // 64 lines for each write: fewer system calls.
      let block = '';
      for (let k = 0; k < 64; k++, i++) block += claudeLine(i, i % 8 === 1 || i % 8 === 3 ? filler : filler.slice(0, 400)) + '\n';
      written += fs.writeSync(fd, block);
    }
  } finally { fs.closeSync(fd); }
  return i;
}

/** Runs `work` with the event-loop delay monitor on. Returns the largest delay and the p99, in ms. */
async function loopDelayDuring(work: () => Promise<void>): Promise<{ maxMs: number; p99Ms: number; wallMs: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 2 });
  await new Promise((resolve) => setTimeout(resolve, 20)); // let earlier synchronous work drain
  histogram.enable();
  // The monitor records the time between two of its own ticks, so it needs one tick before the work
  // starts: without this wait, a block that starts at once is never seen. (Do not call reset()
  // after the wait: it makes the monitor blind in the same way.)
  await new Promise((resolve) => setTimeout(resolve, 12));
  const t0 = performance.now();
  await work();
  const wallMs = performance.now() - t0;
  await new Promise((resolve) => setTimeout(resolve, 10)); // one more sample after the last slice
  histogram.disable();
  return { maxMs: histogram.max / 1e6, p99Ms: histogram.percentile(99) / 1e6, wallMs };
}

describe(`a large generated file (${LARGE_BYTES / 1024 / 1024} MB)`, () => {
  let dir: string;
  let file: string;
  let lines: number;
  let largeDb: Database.Database;
  let reader: ConversationReader;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-conv-large-'));
    file = path.join(dir, 'large.jsonl');
    lines = writeLargeTranscript(file, LARGE_BYTES);
    largeDb = new Database(':memory:');
    initSchema(largeDb);
    reader = readerFor(file, parseClaudeTranscript, largeDb);
  }, 120_000);
  afterAll(() => {
    try { largeDb.close(); } catch { /* noop */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a large generated file: no event-loop block over 50 ms during a page read', async () => {
    expect(fs.statSync(file).size).toBeGreaterThanOrEqual(LARGE_BYTES);
    const spy = vi.spyOn(fs, 'readFileSync');
    const report: Record<string, string> = {};
    const measure = async (name: string, work: () => Promise<void>) => {
      const r = await loopDelayDuring(work);
      report[name] = `wall ${r.wallMs.toFixed(1)} ms, loop delay max ${r.maxMs.toFixed(1)} ms, p99 ${r.p99Ms.toFixed(1)} ms`;
      expect(r.maxMs, `${name}: largest event-loop delay`).toBeLessThan(BLOCK_LIMIT_MS);
    };

    // The first page builds the index of the whole file.
    let first!: ConvPage;
    await measure('first page (index build)', async () => { first = await reader.page('t', { limit: 200 }); });
    expect(first.cursor).toBe(lines);
    expect(first.startLine).toBe(lines - 200);

    await measure('50 older pages', async () => {
      let before = first.startLine;
      for (let i = 0; i < 50; i++) before = (await reader.page('t', { before, limit: 200 })).startLine;
    });
    await measure('a page in the middle and a page at the start', async () => {
      await reader.page('t', { before: Math.floor(lines / 2), limit: 200 });
      await reader.page('t', { before: 200, limit: 200 });
    });
    await measure('beforeUuid near the tail', async () => { await reader.page('t', { beforeUuid: `uuid-${lines - 400}`, limit: 200 }); });
    await measure('beforeUuid that is not in the file (scans all of it)', async () => { await reader.page('t', { beforeUuid: 'not-in-this-file', limit: 200 }); });
    await measure('poll for 5,000 new lines', async () => { await reader.page('t', { since: lines - 5000 }); });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    console.log(`[W2-B large file ${LARGE_BYTES / 1024 / 1024} MB, ${lines} lines]\n` + Object.entries(report).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
  }, 120_000);

  it('a large generated file: no event-loop block over 50 ms during a search of the whole file', async () => {
    let found = 0;
    const r = await loopDelayDuring(async () => { found = (await reader.search('t', 'needle0?')).matches.length; });
    console.log(`[W2-B large file search] wall ${r.wallMs.toFixed(1)} ms, loop delay max ${r.maxMs.toFixed(1)} ms, p99 ${r.p99Ms.toFixed(1)} ms`);
    expect(found).toBe(1);
    expect(r.maxMs).toBeLessThan(BLOCK_LIMIT_MS);
  }, 120_000);

  it('a large generated file: each page is the same as the old reader gives, in both directions and with beforeUuid anchors', async () => {
    // The old code path: the whole file in memory, read and split synchronously. The same monitor
    // that the test above uses must see it as a block, or that test proves nothing.
    let usable: string[] = [];
    const old = await loopDelayDuring(async () => { usable = oldUsable(file); oldPage(usable, parseClaudeTranscript, { limit: 200 }); });
    console.log(`[W2-B large file, OLD synchronous page] wall ${old.wallMs.toFixed(1)} ms, loop delay max ${old.maxMs.toFixed(1)} ms`);
    expect(old.maxMs).toBeGreaterThan(BLOCK_LIMIT_MS);
    expect(usable.length).toBe(lines);
    const same = async (opts: PageOpts) => expectSame(await reader.page('t', opts), oldPage(usable, parseClaudeTranscript, opts));

    // Upward from the tail: the first 40 pages, then every 25th page down to the first line.
    let before: number | undefined;
    for (let n = 0; ; n++) {
      const opts = { before, limit: 200 };
      const page = await reader.page('t', opts);
      if (n < 40 || n % 25 === 0 || !page.hasMore || page.startLine < 1000) expectSame(page, oldPage(usable, parseClaudeTranscript, opts));
      if (!page.hasMore) { expect(page.startLine).toBe(0); break; }
      before = page.startLine;
    }

    // Downward (polls) from several cursors near the tail, and one far from it.
    for (const since of [lines - 1, lines - 200, lines - 3333, lines - 20_000]) await same({ since });

    // Anchors: at the tail, 300 KB back, in the middle, at the start, missing.
    for (const at of [lines - 8, lines - 400, lines - 4000, Math.floor(lines / 2 / 8) * 8, 8, 0]) await same({ beforeUuid: `uuid-${at}`, limit: 200 });
    await same({ beforeUuid: 'not-in-this-file', limit: 200 });
    await same({ beforeUuid: `uuid-${lines - 400}`, before: 100, since: 5, limit: 50 });

    expectSame(await reader.search('t', 'needle0?'), oldSearch(usable, 'needle0?'));
    expectSame(await reader.search('t', 'answer', 200), oldSearch(usable, 'answer', 200));
  }, 240_000);

  it('a large generated file: lines appended during a walk upward do not change the pages', async () => {
    const before0 = (await reader.page('t', { limit: 200 })).cursor;
    const walk = (async () => {
      const pages: ConvPage[] = [];
      let before = before0;
      for (let i = 0; i < 30; i++) {
        const page = await reader.page('t', { before, limit: 200 });
        pages.push(page);
        before = page.startLine;
      }
      return pages;
    })();
    // Appends land while the walk runs.
    for (let i = 0; i < 20; i++) {
      fs.appendFileSync(file, claudeLine(lines + i) + '\n');
      await new Promise((resolve) => setImmediate(resolve));
    }
    const pages = await walk;
    const usable = oldUsable(file);
    expect(usable.length).toBe(lines + 20);
    let before = before0;
    for (const page of pages) {
      const expected = oldPage(usable, parseClaudeTranscript, { before, limit: 200 });
      expect(JSON.stringify(page.items)).toBe(JSON.stringify(expected.items));
      expect(page.startLine).toBe(expected.startLine);
      expect(page.cursor).toBeGreaterThanOrEqual(lines);
      expect(page.cursor).toBeLessThanOrEqual(lines + 20);
      before = page.startLine;
    }
    expectSame(await reader.page('t', { since: before0 }), oldPage(usable, parseClaudeTranscript, { since: before0 }));
  }, 240_000);
});
