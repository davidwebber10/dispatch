import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import { EventRing } from '../structured/shared/event-ring.js';
import { MessageJournal } from './journal.js';
import { JournalRecorder } from './recorder.js';

function setup(wholeFrames: boolean, seeds?: unknown[]) {
  const db = new Database(':memory:');
  initSchema(db);
  const journal = new MessageJournal(db);
  const recorder = new JournalRecorder(journal);
  const ring = new EventRing();
  const thread = recorder.attach('t', ring, { wholeFrames, seeds });
  const rows = () => journal.page('t', { limit: 500 }).items;
  return { db, journal, recorder, ring, thread, rows };
}
const se = (event: Record<string, unknown>, parent?: string) => ({ type: 'stream_event', event, ...(parent ? { parent_tool_use_id: parent } : {}) });
const userText = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
const whole = (block: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [block] }, ...extra });
const result = (extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, ...extra });
/** One event of an agent's replay of its history (ACP session/load). */
const replay = (thread: { beginReplay(): void; endReplay(): void }, ring: EventRing, event: unknown) => { thread.beginReplay(); ring.push(event); thread.endReplay(); };

/** A streamed text block as Codex and ACP send it: no whole frame follows. */
function streamBlock(ring: EventRing, index: number, pieces: string[], kind: 'text' | 'thinking' = 'text', stop: Record<string, unknown> = {}) {
  ring.push(se({ type: 'content_block_start', index, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } }));
  for (const p of pieces) ring.push(se({ type: 'content_block_delta', index, delta: kind === 'text' ? { type: 'text_delta', text: p } : { type: 'thinking_delta', thinking: p } }));
  const stopEvent = se({ type: 'content_block_stop', index, ...stop });
  ring.push(stopEvent);
  return stopEvent as Record<string, unknown>;
}

describe('JournalRecorder: a harness that streams and sends no whole message (Codex, ACP)', () => {
  it('a finished assistant message is journaled once; its deltas are not', () => {
    const { ring, rows } = setup(false);
    ring.push(userText('hello'));
    ring.push(se({ type: 'message_start' }));
    const stop = streamBlock(ring, 0, ['Hel', 'lo ', 'there']);
    ring.push(result());
    expect(rows().map((r) => r.kind)).toEqual(['user', 'assistant', 'result']);
    expect((rows()[1].payload as any).message.content).toEqual([{ type: 'text', text: 'Hello there' }]);
    expect(stop.seq).toBe(2); // the event that finished the item carries the sequence
    expect(JSON.stringify(rows())).not.toContain('content_block_delta');
  });

  it('each finished event carries its sequence, and the sequence is in ring order', () => {
    const { ring } = setup(false);
    const u = userText('q') as Record<string, unknown>; ring.push(u);
    ring.push(se({ type: 'message_start' }));
    const thinkStop = streamBlock(ring, 0, ['hm'], 'thinking');
    const tool = whole({ type: 'tool_use', id: 'call-1', name: 'Shell', input: { command: 'ls' } }) as Record<string, unknown>; ring.push(tool);
    const out = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'a.txt' }] } } as Record<string, unknown>; ring.push(out);
    const textStop = streamBlock(ring, 1, ['done']);
    const r = result() as Record<string, unknown>; ring.push(r);
    expect([u.seq, thinkStop.seq, tool.seq, out.seq, textStop.seq, r.seq]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a tool call that the harness sends again with the same id updates its row', () => {
    const { ring, rows } = setup(false);
    ring.push(whole({ type: 'tool_use', id: 'call-1', name: 'bash', input: { cwd: '/' } }));
    ring.push(userText('between'));
    const again = whole({ type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'ls -la' } }) as Record<string, unknown>;
    ring.push(again);
    expect(rows().map((r) => [r.seq, r.kind])).toEqual([[1, 'tool'], [2, 'user']]);
    expect((rows()[0].payload as any).message.content[0].input).toEqual({ command: 'ls -la' });
    expect(again.seq).toBe(1);
  });

  it('the final_text of a stop wins over the deltas', () => {
    const { ring, rows } = setup(false);
    ring.push(se({ type: 'message_start' }));
    streamBlock(ring, 0, ['par'], 'text', { final_text: 'the whole reply' });
    expect((rows()[0].payload as any).message.content[0].text).toBe('the whole reply');
  });

  it('a block with no stop is finished by the turn end, before the result', () => {
    const { ring, rows } = setup(false);
    ring.push(se({ type: 'message_start' }));
    ring.push(se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    ring.push(se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } }));
    ring.push(result());
    expect(rows().map((r) => r.kind)).toEqual(['assistant', 'result']);
    expect((rows()[0].payload as any).message.content).toEqual([{ type: 'thinking', thinking: 'reasoning' }]);
  });

  it('usage frames, init, status and the backfill settle are not journaled; a notice is', () => {
    const { ring, rows } = setup(false);
    ring.push({ type: 'system', subtype: 'init', model: 'm' });
    ring.push({ type: 'assistant', subtype: 'context_fill', message: { role: 'assistant', content: [], usage: { input_tokens: 5 } } });
    ring.push({ type: 'system', subtype: 'status', status: 'compacting' });
    ring.push({ type: 'result', subtype: 'backfill', is_error: false });
    ring.push({ type: 'user', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: 'injected' }] } });
    ring.push({ type: 'user', message: { role: 'user', content: [] } });
    expect(rows()).toEqual([]);
    ring.push({ type: 'system', subtype: 'model', model: 'grok-5', switched: true });
    ring.push({ type: 'system', subtype: 'settings_refused', message: 'no' });
    ring.push({ type: 'system', subtype: 'spawn_error', message: 'ENOENT' });
    expect(rows().map((r) => r.kind)).toEqual(['notice', 'notice', 'notice']);
    // A daemon warning is kept; an info notice is not.
    ring.push({ type: 'system', subtype: 'dispatch_notice', level: 'info', message: 'fyi' });
    ring.push({ type: 'system', subtype: 'dispatch_notice', level: 'warning', message: 'tools the workspace did not give' });
    expect(rows().map((r) => r.kind)).toEqual(['notice', 'notice', 'notice', 'notice']);
    expect((rows()[3].payload as any).message).toBe('tools the workspace did not give');
  });

  it('an empty or blank streamed block makes no row', () => {
    const { ring, rows } = setup(false);
    ring.push(se({ type: 'message_start' }));
    streamBlock(ring, 0, ['  ', '\n']);
    streamBlock(ring, 1, []);
    expect(rows()).toEqual([]);
  });

  it('a replay of the agent (session/load) fills an empty journal once, and is ignored after the import', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const journal = new MessageJournal(db);
    const rows = () => journal.page('t', { limit: 500 }).items;

    const ring1 = new EventRing();
    const first = new JournalRecorder(journal).attach('t', ring1, { wholeFrames: false, replaySession: 's1' });
    replay(first, ring1, userText('earlier question'));
    replay(first, ring1, whole({ type: 'text', text: 'earlier answer' }));
    first.loadEnded(true);
    expect(rows().map((r) => r.kind)).toEqual(['user', 'assistant']);

    // The daemon starts again on the same database: the agent replays the same history.
    const ring2 = new EventRing();
    const again = new JournalRecorder(journal).attach('t', ring2, { wholeFrames: false, replaySession: 's1' });
    const replayed = userText('earlier question') as Record<string, unknown>;
    replay(again, ring2, replayed);
    // A message sent while the replay is on its way is a live event: it is written.
    ring2.push(userText('sent during the load'));
    replay(again, ring2, whole({ type: 'text', text: 'earlier answer' }));
    again.loadEnded(true);
    expect(rows().map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(replayed.seq).toBeUndefined();
    expect(replayed.journal_replayed).toBe(true);
    expect((rows()[2].payload as any).message.content[0].text).toBe('sent during the load');
  });

  it('a message sent before the replayed history of an old thread is in comes after that history', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const journal = new MessageJournal(db);
    const ring = new EventRing();
    const thread = new JournalRecorder(journal).attach('t', ring, { wholeFrames: false, replaySession: 's1' });
    ring.push(userText('sent right after the resume')); // before the first replayed frame
    thread.beginReplay(); ring.push(userText('earlier question')); thread.endReplay();
    thread.beginReplay(); ring.push(whole({ type: 'text', text: 'earlier answer' })); thread.endReplay();
    thread.loadEnded(true);
    const texts = journal.page('t').items.map((r) => (r.payload as any).message.content[0].text);
    expect(texts).toEqual(['earlier question', 'earlier answer', 'sent right after the resume']);
  });
});

// Final review of v4.5.0, C2. The import of a replayed history was decided by "the journal has no
// row". A load that failed left a notice as row 1, so no later replay was ever imported and the
// history of the thread was gone for a journal client. The import is now decided by a mark for the
// session, written only after a load that worked.
describe('JournalRecorder: the import of a replayed history (ACP session/load)', () => {
  function world() {
    const db = new Database(':memory:');
    initSchema(db);
    const journal = new MessageJournal(db);
    const rows = () => journal.page('t', { limit: 500 }).items.map((r) => [r.seq, r.kind, (r.payload as any).message?.content?.[0]?.text ?? (r.payload as any).subtype]);
    const attach = (session: string | undefined) => {
      const ring = new EventRing();
      const thread = new JournalRecorder(journal).attach('t', ring, { wholeFrames: false, replaySession: session });
      return { ring, thread };
    };
    return { db, journal, rows, attach };
  }
  const spawnError = () => ({ type: 'system', subtype: 'spawn_error', message: 'the session could not be loaded' });

  it('a first load that fails writes no mark: the next load that works imports the history, once', () => {
    const { rows, attach, journal } = world();
    const first = attach('s1');
    first.thread.loadEnded(false); // the agent refused the load and replayed nothing
    first.ring.push(spawnError());
    expect(rows()).toEqual([[1, 'notice', 'spawn_error']]);
    expect(journal.hasImport('t', 's1')).toBe(false);

    const second = attach('s1');
    const q = userText('earlier question') as Record<string, unknown>;
    replay(second.thread, second.ring, q);
    replay(second.thread, second.ring, whole({ type: 'text', text: 'earlier answer' }));
    second.thread.loadEnded(true);
    expect(rows()).toEqual([[1, 'notice', 'spawn_error'], [2, 'user', 'earlier question'], [3, 'assistant', 'earlier answer']]);
    expect(q.seq).toBe(2);
    expect(q.journal_replayed).toBeUndefined(); // new to the journal: a journal client gets it
    expect(journal.hasImport('t', 's1')).toBe(true);

    const third = attach('s1');
    const again = userText('earlier question') as Record<string, unknown>;
    replay(third.thread, third.ring, again);
    replay(third.thread, third.ring, whole({ type: 'text', text: 'earlier answer' }));
    third.thread.loadEnded(true);
    expect(rows()).toHaveLength(3);
    expect(again.journal_replayed).toBe(true);
  });

  it('a load that fails after a part of the history is completed by the next load, not written twice', () => {
    const { rows, attach, journal } = world();
    const first = attach('s1');
    replay(first.thread, first.ring, userText('yes'));
    replay(first.thread, first.ring, whole({ type: 'text', text: 'ok' }));
    first.thread.loadEnded(false);
    first.ring.push(spawnError());
    expect(rows()).toEqual([[1, 'user', 'yes'], [2, 'assistant', 'ok'], [3, 'notice', 'spawn_error']]);
    expect(journal.hasImport('t', 's1')).toBe(false);

    const second = attach('s1');
    const events = [userText('yes'), whole({ type: 'text', text: 'ok' }), userText('yes'), whole({ type: 'text', text: 'ok' }), userText('more')] as Record<string, unknown>[];
    for (const e of events) replay(second.thread, second.ring, e);
    second.thread.loadEnded(true);
    // The same words two times are two items: the journal had the first pair, it gets the second.
    expect(rows()).toEqual([[1, 'user', 'yes'], [2, 'assistant', 'ok'], [3, 'notice', 'spawn_error'], [4, 'user', 'yes'], [5, 'assistant', 'ok'], [6, 'user', 'more']]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 4, 5, 6]);
    expect(events.map((e) => e.journal_replayed === true)).toEqual([true, true, false, false, false]); // a journal client has the first two
    expect(journal.hasImport('t', 's1')).toBe(true);
  });

  it('a tool call of a part import keeps its row', () => {
    const { rows, attach } = world();
    const tool = () => whole({ type: 'tool_use', id: 'call-1', name: 'Shell', input: { command: 'ls' } });
    const first = attach('s1');
    replay(first.thread, first.ring, tool());
    first.thread.loadEnded(false);
    const second = attach('s1');
    replay(second.thread, second.ring, tool());
    replay(second.thread, second.ring, whole({ type: 'text', text: 'done' }));
    second.thread.loadEnded(true);
    expect(rows().map((r) => [r[0], r[1]])).toEqual([[1, 'tool'], [2, 'assistant']]);
  });

  it('a session that started under the journal is never imported: the journal has it from its first item', () => {
    const { rows, attach, journal } = world();
    const first = attach(undefined);
    first.thread.sessionStarted('s1');
    first.ring.push(userText('question'));
    first.ring.push(se({ type: 'message_start' }));
    streamBlock(first.ring, 0, ['ans', 'wer']);
    first.ring.push(result());
    expect(journal.hasImport('t', 's1')).toBe(true);

    const second = attach('s1');
    // The agent replays the reply with other white space: no match by words is needed, or tried.
    replay(second.thread, second.ring, userText('question'));
    replay(second.thread, second.ring, whole({ type: 'text', text: 'answer, as the agent keeps it' }));
    second.thread.loadEnded(true);
    expect(rows().map((r) => r[1])).toEqual(['user', 'assistant', 'result']);
  });

  it('the mark is for one session: the history of another session of the thread is imported', () => {
    const { rows, attach } = world();
    const first = attach('s1');
    replay(first.thread, first.ring, userText('in the first session'));
    first.thread.loadEnded(true);
    const second = attach('s2');
    replay(second.thread, second.ring, userText('in the second session'));
    second.thread.loadEnded(true);
    expect(rows().map((r) => r[2])).toEqual(['in the first session', 'in the second session']);
  });

  it('a deleted thread loses its marks', () => {
    const { journal, attach } = world();
    attach('s1').thread.loadEnded(true);
    expect(journal.hasImport('t', 's1')).toBe(true);
    journal.removeThread('t');
    expect(journal.hasImport('t', 's1')).toBe(false);
  });

  it('close writes the blocks that stream (a kill, a process exit, a daemon stop)', () => {
    const { rows, attach } = world();
    const { ring, thread } = attach(undefined);
    ring.push(userText('question'));
    ring.push(se({ type: 'message_start' }));
    ring.push(se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    ring.push(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half an ans' } }));
    thread.close();
    expect(rows()).toEqual([[1, 'user', 'question'], [2, 'assistant', 'half an ans']]);
    thread.close(); // a second close (the next attach) adds nothing
    expect(rows()).toHaveLength(2);
  });
});

describe('JournalRecorder: a harness that sends each block again as a whole frame (Claude)', () => {
  it('a finished assistant message is journaled once; its deltas are not', () => {
    const { ring, rows } = setup(true);
    ring.push(userText('hello'));
    ring.push(se({ type: 'message_start', message: { id: 'msg_1' } }));
    ring.push(se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    ring.push(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }));
    ring.push(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }));
    ring.push(se({ type: 'content_block_stop', index: 0 }));
    const frame = whole({ type: 'text', text: 'Hello' }, { uuid: 'u-a1' }) as any;
    frame.message.id = 'msg_1';
    ring.push(frame);
    ring.push(se({ type: 'message_stop' }));
    ring.push(result());
    expect(rows().map((r) => [r.kind, r.nativeId])).toEqual([['user', null], ['assistant', 'u-a1'], ['result', null]]);
    expect(frame.seq).toBe(2);
    expect(JSON.stringify(rows())).not.toContain('content_block_delta');
  });

  it('the same uuid twice is one row', () => {
    const { ring, rows } = setup(true);
    ring.push(whole({ type: 'text', text: 'once' }, { uuid: 'u-1' }));
    ring.push(whole({ type: 'text', text: 'once' }, { uuid: 'u-1' }));
    expect(rows()).toHaveLength(1);
  });

  it('a message that was cut off keeps the text it streamed, written at the turn end', () => {
    const { ring, rows } = setup(true);
    ring.push(se({ type: 'message_start', message: { id: 'msg_1' } }));
    ring.push(se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    ring.push(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half an ans' } }));
    ring.push(result({ subtype: 'error_during_execution', is_error: true }));
    expect(rows().map((r) => r.kind)).toEqual(['assistant', 'result']);
    expect((rows()[0].payload as any).message.content[0].text).toBe('half an ans');
    expect((rows()[0].payload as any).partial).toBe(true);
  });

  it('a block that got its whole frame is not written a second time from its deltas', () => {
    const { ring, rows } = setup(true);
    ring.push(se({ type: 'message_start', message: { id: 'msg_1' } }));
    for (const [i, text] of ['first', 'second'].entries()) {
      ring.push(se({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }));
      ring.push(se({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text } }));
      ring.push(se({ type: 'content_block_stop', index: i }));
      if (i === 0) { const f = whole({ type: 'text', text }, { uuid: 'u-0' }) as any; f.message.id = 'msg_1'; ring.push(f); }
    }
    ring.push(result()); // the second block got no whole frame
    expect(rows().map((r) => (r.payload as any).message?.content?.[0]?.text ?? r.kind)).toEqual(['first', 'second', 'result']);
  });

  it('a tool result is a row of kind tool, with the native id of its frame', () => {
    const { ring, rows } = setup(true);
    ring.push(whole({ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }, { uuid: 'u-t' }));
    ring.push({ type: 'user', uuid: 'u-r', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
    expect(rows().map((r) => [r.kind, r.nativeId])).toEqual([['tool', 'u-t'], ['tool', 'u-r']]);
  });

  it('a task notification is a notice', () => {
    const { ring, rows } = setup(true);
    ring.push(userText('<task-notification><summary>Background task done</summary></task-notification>'));
    expect(rows().map((r) => r.kind)).toEqual(['notice']);
  });
});

describe('JournalRecorder: history from the transcript at spawn (Claude seeds)', () => {
  const seedsA = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first question' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
    { type: 'result', subtype: 'backfill', is_error: false },
  ];

  it('a thread from before the journal gets its seed history, once', () => {
    const a = setup(true, seedsA);
    expect(a.rows().map((r) => [r.seq, r.kind, r.nativeId])).toEqual([[1, 'user', 'u1'], [2, 'assistant', 'a1']]);
    // The next spawn seeds the same history: nothing is added.
    new JournalRecorder(a.journal).attach('t', new EventRing(), { wholeFrames: true, seeds: seedsA });
    expect(a.rows()).toHaveLength(2);
  });

  it('items that the transcript got outside the journal are added after the items it has', () => {
    const a = setup(true, seedsA);
    a.ring.push(userText('second question')); // the daemon's own echo: no uuid
    a.ring.push(whole({ type: 'text', text: 'second answer' }, { uuid: 'a2' }));
    const later = [
      ...seedsA.slice(0, 2),
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second question' } },
      { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } },
      { type: 'user', uuid: 'u3', message: { role: 'user', content: 'typed in the CLI' } },
      { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'text', text: 'answered in the CLI' }] } },
    ];
    new JournalRecorder(a.journal).attach('t', new EventRing(), { wholeFrames: true, seeds: later });
    expect(a.rows().map((r) => [r.seq, r.nativeId])).toEqual([[1, 'u1'], [2, 'a1'], [3, null], [4, 'a2'], [5, 'u3'], [6, 'a3']]);
  });

  it('the echo of a turn that was cut off is matched with its transcript line, not added again', () => {
    const a = setup(true, seedsA);
    a.ring.push(userText('interrupted question')); // no answer: the daemon stopped
    const later = [...seedsA.slice(0, 2), { type: 'user', uuid: 'u2', message: { role: 'user', content: 'interrupted question' } }];
    new JournalRecorder(a.journal).attach('t', new EventRing(), { wholeFrames: true, seeds: later });
    expect(a.rows().map((r) => [r.seq, r.kind, r.nativeId])).toEqual([[1, 'user', 'u1'], [2, 'assistant', 'a1'], [3, 'user', 'u2']]);
    expect((a.rows()[2].payload as any).uuid).toBe('u2');
  });

  it('a transcript with nothing in common with the journal sets a gap mark, and the page starts after it', () => {
    const a = setup(true);
    a.ring.push(userText('journal only'));
    new JournalRecorder(a.journal).attach('t', new EventRing(), { wholeFrames: true, seeds: seedsA });
    const page = a.journal.page('t');
    expect(page.items.map((r) => r.nativeId)).toEqual(['u1', 'a1']);
    expect(page.firstSeq).toBe(3);
    expect(page.hasMore).toBe(false);
  });
});

describe('JournalRecorder: what is not finished yet', () => {
  it('openEvents gives the open blocks as a start and one delta, and nothing once they are finished', () => {
    const { ring, recorder } = setup(false);
    ring.push(se({ type: 'message_start' }));
    ring.push(se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    ring.push(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'so ' } }));
    ring.push(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'far' } }));
    expect(recorder.openEvents('t')).toEqual([
      se({ type: 'message_start' }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'so far' } }),
    ]);
    ring.push(se({ type: 'content_block_stop', index: 0 }));
    expect(recorder.openEvents('t')).toEqual([]);
    expect(recorder.openEvents('unknown')).toEqual([]);
  });

  // Final review of v4.5.0, C1: Claude sends each block again as a whole frame of ONE block, so the
  // position of a block in its frame is always 0. A viewer that connects in the middle of a message
  // needs the id of the message and the count of whole frames it had, or it cannot tell which
  // streamed block a later whole frame finishes (it showed the text block two times).
  it('openEvents of a Claude message gives the id of the message and the count of its whole frames', () => {
    const { ring, recorder } = setup(true);
    const frame = (block: Record<string, unknown>) => ({ type: 'assistant', uuid: `u-${String(block.type)}`, message: { id: 'msg_1', role: 'assistant', content: [block] } });
    ring.push(se({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } }));
    ring.push(se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    ring.push(se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }));
    ring.push(se({ type: 'content_block_stop', index: 0 }));
    ring.push(frame({ type: 'thinking', thinking: 'hm' }));
    // Between two blocks: no block is open, and the message is still in flight.
    const head = se({ type: 'message_start', message: { id: 'msg_1' }, wholes: 1 });
    expect(recorder.openEvents('t')).toEqual([head]);
    ring.push(se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
    ring.push(se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'so ' } }));
    ring.push(se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'far' } }));
    expect(recorder.openEvents('t')).toEqual([
      head,
      se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'so far' } }),
    ]);
    ring.push(se({ type: 'content_block_stop', index: 1 }));
    ring.push(frame({ type: 'text', text: 'so far' }));
    ring.push(se({ type: 'message_stop' }));
    expect(recorder.openEvents('t')).toEqual([]); // the message ended: nothing is in flight
  });

  it('stateEvents gives the last usage and a standing sign-in notice; a good result clears the notice', () => {
    const { ring, recorder } = setup(true);
    const frame = whole({ type: 'text', text: 'x' }, { uuid: 'u1', context_window: 1000 }) as any;
    frame.message.usage = { input_tokens: 7, output_tokens: 1 };
    frame.message.model = 'claude-x';
    ring.push(frame);
    const auth = { type: 'system', subtype: 'auth_required', provider: 'claude', reason: 'expired' };
    ring.push(auth);
    expect(recorder.stateEvents('t')).toEqual([
      { type: 'assistant', message: { role: 'assistant', content: [], usage: { input_tokens: 7, output_tokens: 1 }, model: 'claude-x' }, context_window: 1000 },
      auth,
    ]);
    ring.push(result());
    expect(recorder.stateEvents('t')).toHaveLength(1);
  });

  // Final review of v4.5.0 (minor): after a daemon restart the recorder has no usage in memory. The
  // first window took it from the journal; a resume with a cursor did not, and the context meter
  // of the chat stayed empty until the next reply.
  it('a resume with a cursor after a daemon restart still gets the context usage, from the journal', () => {
    const { ring, journal } = setup(true);
    const frame = whole({ type: 'text', text: 'x' }, { uuid: 'u1', context_window: 1000 }) as any;
    frame.message.usage = { input_tokens: 7, output_tokens: 1 };
    frame.message.model = 'claude-x';
    ring.push(userText('q'));
    ring.push(frame);
    ring.push(result());
    const usage = { type: 'assistant', message: { role: 'assistant', content: [], usage: { input_tokens: 7, output_tokens: 1 }, model: 'claude-x' }, context_window: 1000 };

    const restarted = new JournalRecorder(journal); // a new daemon: no session is attached yet
    const first = restarted.replay('t', { allowReset: true })!;
    expect(first.frame.reset).toBe(true);
    expect(first.tail).toEqual([usage]);
    const resume = restarted.replay('t', { after: 3, allowReset: true })!;
    expect(resume.frame).toMatchObject({ reset: false, after: 3, items: [] });
    expect(resume.tail).toEqual([usage]);
    // The cursor is before the newest reply: the usage is still the newest one of the thread.
    expect(restarted.replay('t', { after: 1, allowReset: true })!.tail).toEqual([usage]);
  });

  it('a journal that cannot write does not stop the ring', () => {
    const { ring, db } = setup(false);
    db.exec('DROP TABLE thread_journal');
    expect(() => ring.push(userText('still delivered'))).not.toThrow();
    expect(ring.length).toBe(1);
  });
});

describe('JournalRecorder: growth', () => {
  it('the journal grows with the finished items, not with the deltas', () => {
    const { ring, journal } = setup(false);
    const pieces = Array.from({ length: 2000 }, (_, i) => `word${i} `);
    let ringChars = 0;
    for (let turn = 0; turn < 5; turn++) {
      ring.push(userText(`question ${turn}`));
      ring.push(se({ type: 'message_start' }));
      streamBlock(ring, 0, pieces);
      ring.push(result());
      ringChars += pieces.reduce((n, p) => n + JSON.stringify(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })).length, 0);
    }
    const stats = journal.stats('t');
    const text = pieces.join('').length;
    expect(stats.rows).toBe(15); // 5 turns of user, assistant, result: not 10,000 deltas
    expect(stats.bytes).toBeLessThan(5 * text + 15 * 300);
    expect(stats.bytes).toBeLessThan(ringChars / 5);
    expect(journal.totals()).toEqual({ rows: 15, bytes: stats.bytes, threads: 1 });
    console.log(`[w3-d] 5 turns of 2,000 deltas: ${ringChars} characters of delta events, ${stats.bytes} characters in the journal (${stats.rows} rows)`);
  });
});
