import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { EndlessStore } from '../../src/endless/store.js';
import { ViewKeeper } from '../../src/endless/view-keeper.js';
import { Compactor } from '../../src/endless/compactor.js';
import { appendLogged, type LogInput } from '../../src/endless/log.js';
import { TurnRunner, type EndlessEvent } from '../../src/endless/turn-runner.js';
import { PLACEHOLDER } from '../../src/endless/view.js';
import { FakeSummarizer, settle } from './fake-summarizer.js';
import { FakeManager, texts } from './fake-manager.js';

function setup(opts: { waitMs?: number; failLogOn?: string; readImage?: () => { mimeType: string; data: string } | null; onEmit?: (e: EndlessEvent) => void } = {}) {
  const db = new Database(':memory:');
  initSchema(db);
  const store = new EndlessStore(db);
  const views = new ViewKeeper(store);
  const summarizer = new FakeSummarizer();
  const compactor = new Compactor({ store, views, summarizer, systemPrompt: () => 'SYS', projectName: () => null });
  const fake = new FakeManager();
  const events: EndlessEvent[] = [];
  const log = (input: LogInput) => {
    if (input.kind === opts.failLogOn) throw new Error(`disk full on ${input.kind}`);
    return appendLogged({ store, views, compactor }, input);
  };
  const runner = new TurnRunner({
    store, views, compactor, manager: fake.asManager(), chatDir: '/chat', mcpConfigPath: '/chat/memory.mcp.json',
    systemPrompt: () => 'SYS', statusBlock: (p) => `<status>\nnow: X; project ${p ?? 'none'}\n</status>`,
    projectName: (id) => (id ? `name-${id}` : null), log, emit: (e) => { events.push(e); opts.onEmit?.(e); },
    readImage: opts.readImage ?? (() => ({ mimeType: 'image/png', data: 'AAAA' })), waitMs: opts.waitMs ?? 50, graceMs: 10,
  });
  return { store, views, compactor, summarizer, fake, events, log, runner };
}
const userRows = (store: EndlessStore) => { const out: string[] = []; for (let i = 0; i < store.count(); i++) { const m = store.get(i)!; if (m.kind === 'user') out.push(m.text); } return out; };
const reply = (t: ReturnType<typeof setup>, text: string) =>
  t.fake.emitEvent({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
const listeners = (f: FakeManager) => ['event', 'exit', 'failed', 'permission'].reduce((n, e) => n + f.listenerCount(e), 0);
const finish = async (t: ReturnType<typeof setup>) => { t.fake.emitEvent({ type: 'result', subtype: 'success', is_error: false }); await t.runner.whenIdle(); };

describe('TurnRunner', () => {
  it('renders the view first, then logs the message; input order is view, status, message', async () => {
    const t = setup();
    t.log({ kind: 'user', text: 'earlier one' });
    t.log({ kind: 'unii', text: 'earlier reply' });
    await settle();
    t.runner.send({ text: 'new message', project: 'p1', media: ['/chat/media/a.png'] });
    await settle();
    const parts = texts(t.fake.sent[0].content);
    expect(parts[0]).toBe('<chat>\n0+1|user: earlier one\n1+1|unii: earlier reply\n</chat>');
    expect(parts.join('')).not.toContain('2+1|');
    expect(parts[1]).toBe('<status>\nnow: X; project p1\n</status>');
    expect(parts[2]).toBe('user (name-p1): new message');
    expect(parts[3]).toBe('[image]');
    expect(t.store.get(2)).toMatchObject({ kind: 'user', text: 'new message', project: 'p1', media: ['/chat/media/a.png'] });
    await finish(t);
  });

  it('spawns a fresh opus session in the fixed folder for every project, with the replaced system prompt', async () => {
    const t = setup();
    t.runner.send({ text: 'a', project: 'p1', media: [] });
    await settle();
    await finish(t);
    t.runner.send({ text: 'b', project: 'p2', media: [] });
    await settle();
    await finish(t);
    expect(t.fake.spawned).toHaveLength(2);
    for (const s of t.fake.spawned) {
      expect(s.opts.workDir).toBe('/chat');
      expect(s.opts.args[s.opts.args.indexOf('--system-prompt') + 1]).toBe('SYS');
      expect(s.opts.args[s.opts.args.indexOf('--model') + 1]).toBe('opus');
      expect(s.opts.args).not.toContain('-r');
    }
    expect(t.fake.spawned[0].id).not.toBe(t.fake.spawned[1].id);
    expect(t.fake.killed).toEqual(t.fake.spawned.map((s) => s.id));
    expect(t.events.map((e) => (e.type === 'endless:turn' ? e.status : null)).filter(Boolean)).toEqual(['waiting', 'running', 'idle', 'waiting', 'running', 'idle']);
  });

  it('logs replies, tool calls and results; streams thinking but never logs it; skips sub-agent steps', async () => {
    const t = setup();
    t.runner.send({ text: 'go', project: 'p1', media: [] });
    await settle();
    t.fake.emitEvent({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } });
    t.fake.emitEvent({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Here' } } });
    t.fake.emitEvent({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: 'hmm' }] } });
    t.fake.emitEvent({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Here' }] } });
    t.fake.emitEvent({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a' } }] } });
    t.fake.emitEvent({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file body' }] } });
    t.fake.emitEvent({ type: 'assistant', parent_tool_use_id: 'tu9', message: { content: [{ type: 'text', text: 'sub-agent words' }] } });
    await finish(t);
    const rows = Array.from({ length: t.store.count() }, (_, i) => t.store.get(i)!);
    expect(rows.map((m) => [m.kind, m.text, m.project])).toEqual([
      ['user', 'go', 'p1'],
      ['unii', 'Here', 'p1'],
      ['tool', 'Read {"file_path":"/a"}', 'p1'],
      ['echo', 'file body', 'p1'],
    ]);
    expect(t.events).toContainEqual({ type: 'endless:delta', kind: 'thinking', text: 'hmm' });
    expect(t.events).toContainEqual({ type: 'endless:delta', kind: 'text', text: 'Here' });
  });

  it('clips tool output to 30,000 characters', async () => {
    const t = setup();
    t.runner.send({ text: 'go', project: null, media: [] });
    await settle();
    t.fake.emitEvent({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'z'.repeat(100_000) }] }] } });
    await finish(t);
    const echo = t.store.get(1)!;
    expect(echo.kind).toBe('echo');
    expect(echo.text.length).toBeLessThanOrEqual(30_000);
    expect(t.store.count()).toBe(2);
  });

  it('a 200 KB user message is logged as 7 consecutive user rows and sent whole', async () => {
    const t = setup();
    const big = 'a'.repeat(200_000);
    t.runner.send({ text: big, project: null, media: [] });
    await settle();
    const rows = userRows(t.store);
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(30_000);
    expect(rows.join('')).toBe(big);
    expect(texts(t.fake.sent[0].content).at(-1)).toBe(`user: ${big}`);
    await finish(t);
  });

  it('hands a mid-turn message to the running process and logs it as user', async () => {
    const t = setup();
    t.runner.send({ text: 'first', project: null, media: [] });
    await settle();
    t.runner.send({ text: 'also this', project: null, media: [] });
    expect(t.fake.spawned).toHaveLength(1);
    expect(t.fake.sent[1]).toEqual({ id: t.fake.lastId(), content: [{ type: 'text', text: 'user: also this' }] });
    expect(userRows(t.store)).toEqual(['first', 'also this']);
    reply(t, 'both done'); // the process answered the hand-off, so the next result ends the turn
    await finish(t);
  });

  it('two sends before the process starts make one turn and log both in order', async () => {
    const t = setup();
    t.runner.send({ text: 'from tab A', project: null, media: [] });
    t.runner.send({ text: 'from tab B', project: null, media: [] });
    await settle();
    expect(t.fake.spawned).toHaveLength(1);
    expect(userRows(t.store)).toEqual(['from tab A', 'from tab B']);
    expect(texts(t.fake.sent[0].content).at(-1)).toBe('user: from tab A');
    expect(texts(t.fake.sent[1].content)).toEqual(['user: from tab B']);
    reply(t, 'both done');
    await finish(t);
  });

  it('proceeds with placeholders after the bounded wait when the compactor is behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const t = setup({ waitMs: 40 });
      t.log({ kind: 'user', text: 'x'.repeat(900) }); // needs a model call that never answers
      await settle();
      t.runner.send({ text: 'now', project: null, media: [] });
      await settle();
      await vi.advanceTimersByTimeAsync(39);
      await settle();
      expect(t.fake.spawned).toHaveLength(0); // still waiting
      expect(t.runner.status).toBe('waiting');
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(t.fake.spawned).toHaveLength(1);
      expect(texts(t.fake.sent[0].content)[0]).toBe(`<chat>\n0+1|${PLACEHOLDER}\n</chat>`);
      expect(userRows(t.store)).toEqual(['x'.repeat(900), 'now']);
      t.fake.emitEvent({ type: 'result', subtype: 'success', is_error: false });
      await vi.advanceTimersByTimeAsync(10);
      await t.runner.whenIdle();
      expect(t.runner.status).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a node that failed 5 times does not block the turn', async () => {
    const t = setup({ waitMs: 60_000 });
    t.log({ kind: 'user', text: 'x'.repeat(900) });
    await settle();
    for (let k = 0; k < 5; k++) {
      // each failure cools the node; the next message (or nothing) retries it
      const s = t.summarizer.sessions.at(-1)!;
      s.fail('boom');
      await settle();
      if (k < 4) { t.compactor.onMessage(0); await settle(); }
    }
    t.runner.send({ text: 'now', project: null, media: [] });
    await settle();
    expect(t.fake.spawned).toHaveLength(1);
    expect(texts(t.fake.sent[0].content)[0]).toBe(`<chat>\n0+1|${PLACEHOLDER}\n</chat>`);
    await finish(t);
  });

  it('waits for the result grace window, so a queued second turn is not cut off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const t = setup();
      t.runner.send({ text: 'go', project: null, media: [] });
      await settle();
      t.fake.emitEvent({ type: 'result', subtype: 'success', is_error: false });
      await vi.advanceTimersByTimeAsync(9);
      t.fake.emitEvent({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'second answer' }] } });
      await vi.advanceTimersByTimeAsync(30);
      expect(t.runner.status).toBe('running');
      t.fake.emitEvent({ type: 'result', subtype: 'success', is_error: false });
      await vi.advanceTimersByTimeAsync(10);
      await t.runner.whenIdle();
      expect(t.runner.status).toBe('idle');
      expect(t.store.get(t.store.count() - 1)!.text).toBe('second answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a crashed turn keeps what was logged, reports failed, and Retry resends the last user message', async () => {
    const t = setup();
    t.runner.send({ text: 'do it', project: 'p1', media: [] });
    await settle();
    t.fake.emitEvent({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'partial' }] } });
    t.fake.emitExit(1);
    await t.runner.whenIdle();
    expect(t.events.at(-1)).toMatchObject({ type: 'endless:turn', status: 'failed' });
    expect(t.store.count()).toBe(2);
    expect(t.runner.retry()).toBe(true);
    await settle();
    expect(t.fake.spawned).toHaveLength(2);
    expect(texts(t.fake.sent.at(-1)!.content).at(-1)).toBe('user (name-p1): do it');
    expect(userRows(t.store)).toEqual(['do it']);
    await finish(t);
  });

  it('denies a permission prompt so the turn never hangs', async () => {
    const t = setup();
    t.runner.send({ text: 'go', project: null, media: [] });
    await settle();
    t.fake.emit('permission', t.fake.lastId(), { requestId: 'r1', toolName: 'ExitPlanMode', input: {} });
    expect(t.fake.answers[0]).toMatchObject({ requestId: 'r1', decision: { behavior: 'deny' } });
    await finish(t);
  });
  it('a throw while recording an event ends the turn failed and never reaches the manager', async () => {
    const t = setup({ failLogOn: 'unii' });
    t.runner.send({ text: 'go', project: null, media: [] });
    await settle();
    expect(() => reply(t, 'hello')).not.toThrow();
    await t.runner.whenIdle();
    expect(t.events.at(-1)).toMatchObject({ type: 'endless:turn', status: 'failed', error: expect.stringContaining('disk full on unii') });
    expect(t.runner.status).toBe('idle');
    expect(listeners(t.fake)).toBe(0);
    expect(t.fake.killed).toEqual([t.fake.lastId()]);
  });

  it('a throw after the watch starts leaks no listeners and kills the process', async () => {
    const t = setup({ readImage: () => { throw new Error('unreadable image'); } });
    t.runner.send({ text: 'look', project: null, media: ['/chat/media/a.png'] });
    await t.runner.whenIdle();
    expect(t.events.at(-1)).toMatchObject({ type: 'endless:turn', status: 'failed', error: 'unreadable image' });
    expect(t.fake.spawned).toHaveLength(1);
    expect(listeners(t.fake)).toBe(0);
    expect(t.fake.killed).toEqual([t.fake.lastId()]);
    expect(t.fake.isAlive(t.fake.lastId())).toBe(false);
  });

  it('a result right after a hand-off waits for the next result, not the grace window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const t = setup();
      t.runner.send({ text: 'first', project: null, media: [] });
      await settle();
      reply(t, 'working on it');
      t.runner.send({ text: 'and this', project: null, media: [] }); // after the last assistant event
      t.fake.emitEvent({ type: 'result', subtype: 'success', is_error: false });
      await vi.advanceTimersByTimeAsync(1_600);
      expect(t.runner.status).toBe('running');
      expect(t.fake.killed).toEqual([]);
      t.fake.emitEvent({ type: 'result', subtype: 'success', is_error: false });
      await vi.advanceTimersByTimeAsync(10);
      await t.runner.whenIdle();
      expect(t.runner.status).toBe('idle');
      expect(t.events.at(-1)).toEqual({ type: 'endless:turn', status: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hand-off with no later result ends the turn failed at the ceiling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const t = setup();
      t.runner.send({ text: 'first', project: null, media: [] });
      await settle();
      reply(t, 'done');
      t.fake.emitEvent({ type: 'result', subtype: 'success', is_error: false });
      await vi.advanceTimersByTimeAsync(5); // inside the grace window
      t.runner.send({ text: 'one more', project: null, media: [] });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(t.runner.status).toBe('running');
      await vi.advanceTimersByTimeAsync(1);
      await t.runner.whenIdle();
      expect(t.events.at(-1)).toMatchObject({ type: 'endless:turn', status: 'failed', error: expect.stringContaining('120 s') });
      expect(listeners(t.fake)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('whenIdle follows a turn started from the idle event, not the finished one', async () => {
    let runner!: TurnRunner;
    let sent = false;
    const t = setup({ onEmit: (e) => {
      if (!sent && e.type === 'endless:turn' && e.status === 'idle') { sent = true; runner.send({ text: 'b', project: null, media: [] }); }
    } });
    runner = t.runner;
    t.runner.send({ text: 'a', project: null, media: [] });
    await settle();
    await finish(t); // the idle event starts turn 2 before turn 1's promise settles
    await settle();
    expect(t.runner.status).toBe('running');
    let idle = false;
    void t.runner.whenIdle().then(() => { idle = true; });
    await settle();
    expect(idle).toBe(false);
    await finish(t);
    expect(idle).toBe(true);
  });

  it('a report while Chat is idle starts a turn whose message is the report; the view leaves it out', async () => {
    const t = setup();
    t.log({ kind: 'user', text: 'start a thread' });
    await settle();
    const [w] = t.log({ kind: 'work', text: '[Fix] report: done', project: 'p1', ref: 't1' });
    t.runner.deliver({ i: w.i, kind: 'work', text: w.text, project: 'p1' });
    await settle();
    expect(t.fake.spawned).toHaveLength(1);
    const parts = texts(t.fake.sent[0].content);
    expect(parts[0]).toBe('<chat>\n0+1|user: start a thread\n</chat>');
    expect(parts.at(-1)).toBe('work (name-p1): [Fix] report: done');
    expect(t.store.count()).toBe(2); // not logged again
    await finish(t);
  });

  it('a report while a turn runs reaches the process between tool calls and is not logged again', async () => {
    const t = setup();
    t.runner.send({ text: 'go', project: null, media: [] });
    await settle();
    const [w] = t.log({ kind: 'work', text: '[Fix] report: done', project: 'p1', ref: 't1' });
    t.runner.deliver({ i: w.i, kind: 'work', text: w.text, project: 'p1' });
    expect(t.fake.spawned).toHaveLength(1);
    expect(texts(t.fake.sent[1].content)).toEqual(['work (name-p1): [Fix] report: done']);
    expect(t.store.count()).toBe(2);
    reply(t, 'noted');
    await finish(t);
  });

  it('two reports at once start one process; the second is handed off', async () => {
    const t = setup();
    const [a] = t.log({ kind: 'work', text: '[A] report: one', ref: 'ta' });
    const [b] = t.log({ kind: 'work', text: '[B] report: two', ref: 'tb' });
    t.runner.deliver({ i: a.i, kind: 'work', text: a.text, project: null });
    t.runner.deliver({ i: b.i, kind: 'work', text: b.text, project: null });
    await settle();
    expect(t.fake.spawned).toHaveLength(1);
    expect(texts(t.fake.sent[0].content).at(-1)).toBe('work: [A] report: one');
    expect(texts(t.fake.sent[0].content).join('')).not.toContain('[B] report');
    expect(texts(t.fake.sent[1].content)).toEqual(['work: [B] report: two']);
    expect(t.store.count()).toBe(2);
    reply(t, 'both seen');
    await finish(t);
  });

  it('a report that arrives while a user turn waits joins that turn in log order, and the view leaves it out', async () => {
    const t = setup();
    t.log({ kind: 'user', text: 'earlier' });
    await settle();
    t.runner.send({ text: 'hello', project: null, media: [] }); // waiting for summaries
    const [w] = t.log({ kind: 'work', text: '[Fix] report: done', ref: 't1' });
    t.runner.deliver({ i: w.i, kind: 'work', text: w.text, project: null });
    await settle();
    expect(t.fake.spawned).toHaveLength(1);
    // The report was logged first (row 1), the user message at the end of the wait (row 2).
    expect(t.store.get(1)).toMatchObject({ kind: 'work', text: '[Fix] report: done' });
    expect(t.store.get(2)).toMatchObject({ kind: 'user', text: 'hello' });
    const first = texts(t.fake.sent[0].content);
    expect(first[0]).toBe('<chat>\n0+1|user: earlier\n</chat>');
    expect(first.at(-1)).toBe('work: [Fix] report: done');
    expect(texts(t.fake.sent[1].content)).toEqual(['user: hello']);
    expect(userRows(t.store)).toEqual(['earlier', 'hello']);
    expect(t.store.count()).toBe(3);
    reply(t, 'both seen');
    await finish(t);
  });

  it('reports and user messages queued during the wait reach the model in log order', async () => {
    const t = setup();
    const [a] = t.log({ kind: 'work', text: '[A] report: one', ref: 'ta' });
    t.runner.deliver({ i: a.i, kind: 'work', text: a.text, project: null }); // starts a turn; it waits
    t.runner.send({ text: 'user words', project: null, media: [] });
    const [c] = t.log({ kind: 'work', text: '[C] report: three', ref: 'tc' });
    t.runner.deliver({ i: c.i, kind: 'work', text: c.text, project: null });
    await settle();
    expect(t.fake.spawned).toHaveLength(1);
    const rows = Array.from({ length: t.store.count() }, (_, i) => t.store.get(i)!.text);
    expect(rows).toEqual(['[A] report: one', '[C] report: three', 'user words']);
    expect(t.fake.sent.map((s) => texts(s.content).at(-1))).toEqual(['work: [A] report: one', 'work: [C] report: three', 'user: user words']);
    expect(texts(t.fake.sent[0].content).join('')).not.toContain('[C] report');
    reply(t, 'all seen');
    await finish(t);
  });

  it('a report queued behind a turn that fails before its process starts is not logged again', async () => {
    const t = setup({ failLogOn: 'user' });
    t.runner.send({ text: 'hello', project: null, media: [] });
    const [w] = t.log({ kind: 'work', text: '[Fix] report: done', ref: 't1' });
    t.runner.deliver({ i: w.i, kind: 'work', text: w.text, project: null });
    await t.runner.whenIdle();
    expect(t.fake.spawned).toHaveLength(0);
    expect(t.store.count()).toBe(1); // only the report, once
  });
});
