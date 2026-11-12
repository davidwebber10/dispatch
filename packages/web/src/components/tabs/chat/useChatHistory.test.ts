// packages/web/src/components/tabs/chat/useChatHistory.test.ts
// W3-D: the chat reads the daemon's message journal. An item has a `seq`; two items with the same
// `seq` are one item. The first window comes on the socket (a `journal` frame), older pages come
// from the journal route, and below the journal's first sequence from the transcript route.
// A reconnect sends a cursor and gets only what is newer.
import { renderHook, act } from '@testing-library/react';
import { test, expect, vi, beforeEach, describe } from 'vitest';
import { useStructuredChat } from './useStructuredChat';
import { ResumeTracker, FILL_TARGET, prependJournalRows } from './useChatHistory';
import { itemsFromEvent } from './convItems';
import * as sock from '../../../api/structured-socket';
import { api } from '../../../api/client';
import { threadViewCache } from '../../../lib/threadViewCache';
import type { ConvItem, JournalFrame, JournalItem } from '../../../api/types';

interface Cbs {
  onEvent: (e: any) => void; onReset?: () => void; onClose?: () => void; onReplayEnd?: () => void;
  onEventSeen?: (e: unknown) => void; onJournal?: (f: JournalFrame) => void; resumeAfter?: () => number | undefined;
}
let cbs: Cbs;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  threadViewCache.clear();
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation((opts: any) => { cbs = opts; return { close: () => {} }; });
});

// ---- helpers: journal rows and socket events ----
const userEvent = (text: string, extra: object = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
const assistantEvent = (text: string, extra: object = {}) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
const resultEvent = () => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5 });
const row = (seq: number, payload: any): JournalItem => ({ seq, kind: payload.type === 'user' ? 'user' : payload.type === 'result' ? 'result' : 'assistant', at: '2026-11-09T12:00:00.000Z', payload });
const frame = (items: JournalItem[], over: Partial<JournalFrame> = {}): JournalFrame => ({
  type: 'journal', reset: true, after: null, items, firstSeq: items[0]?.seq ?? 0, lastSeq: items[items.length - 1]?.seq ?? 0, hasMore: false, ...over,
});
/** What the socket client does with each event: the history sees it first, then the fold. */
const live = (e: any) => act(() => { cbs.onEventSeen?.(e); cbs.onEvent(e); });
const journal = (f: JournalFrame) => act(() => { cbs.onJournal!(f); cbs.onReplayEnd?.(); });
const texts = (items: ConvItem[]) => items.map((i) => `${i.kind}:${i.text ?? ''}`);
const seqs = (items: ConvItem[]) => items.map((i) => i.seq);
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

// ---- the journal frame ----

test('a journal frame is the first view: each item has its seq', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  journal(frame([row(1, userEvent('question')), row(2, assistantEvent('answer')), row(3, resultEvent())]));
  expect(texts(result.current.items)).toEqual(['user:question', 'assistant:answer', 'result:']);
  expect(seqs(result.current.items)).toEqual([1, 2, 3]);
  expect(result.current.stale).toBe(false);
});

test('two items with the same seq render once', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  journal(frame([row(1, userEvent('question')), row(2, assistantEvent('answer'))]));
  // A resume that overlaps what the view has (it should not, but nothing may show twice).
  journal(frame([row(2, assistantEvent('answer')), row(3, userEvent('next'))], { reset: false, after: 1 }));
  expect(seqs(result.current.items)).toEqual([1, 2, 3]);
  expect(texts(result.current.items)).toEqual(['user:question', 'assistant:answer', 'user:next']);
  // The same event live, with a seq the view has, adds nothing.
  live({ ...userEvent('next'), seq: 3 });
  expect(seqs(result.current.items)).toEqual([1, 2, 3]);
});

test('two different items with the same words and different seq both render (nothing is removed by content)', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  journal(frame([row(1, userEvent('yes')), row(2, assistantEvent('ok')), row(3, userEvent('yes')), row(4, assistantEvent('ok'))]));
  expect(texts(result.current.items)).toEqual(['user:yes', 'assistant:ok', 'user:yes', 'assistant:ok']);
  // An older journal page with the same words again: all of it lands.
  vi.spyOn(api, 'getJournal').mockResolvedValue({ items: [], firstSeq: 1, lastSeq: 4, hasMore: false });
  expect(result.current.items).toHaveLength(4);
});

test('a journal frame replaces a stale view from the cache, in one step', () => {
  const first = renderHook(() => useStructuredChat('t1'));
  journal(frame([row(1, userEvent('question')), row(2, assistantEvent('answer'))]));
  first.unmount();
  const second = renderHook(() => useStructuredChat('t1'));
  expect(second.result.current.stale).toBe(true);
  expect(second.result.current.items).toHaveLength(2);
  journal(frame([row(1, userEvent('question')), row(2, assistantEvent('answer')), row(3, userEvent('more'))]));
  expect(second.result.current.stale).toBe(false);
  expect(seqs(second.result.current.items)).toEqual([1, 2, 3]);
});

// ---- older pages ----

test('older pages come from the journal route, anchored on the oldest seq', async () => {
  const { result } = renderHook(() => useStructuredChat('t1', undefined, { pageableHistory: false })); // Grok: no transcript route
  const getJournal = vi.spyOn(api, 'getJournal').mockResolvedValueOnce({
    items: [row(3, userEvent('q2')), row(4, assistantEvent('a2'))], firstSeq: 1, lastSeq: 6, hasMore: true,
  }).mockResolvedValueOnce({
    items: [row(1, userEvent('q1')), row(2, assistantEvent('a1'))], firstSeq: 1, lastSeq: 6, hasMore: false,
  });
  const getConversation = vi.spyOn(api, 'getConversation');
  journal(frame([row(5, userEvent('q3')), row(6, assistantEvent('a3'))], { firstSeq: 1, hasMore: true }));
  expect(result.current.hasMore).toBe(true); // the journal has more, though this harness has no transcript
  // Newest first: right after the first window, one page fills the view up to FILL_TARGET items.
  await flush();
  expect(getJournal).toHaveBeenLastCalledWith('t1', { before: 5, limit: FILL_TARGET - 2 });
  expect(seqs(result.current.items)).toEqual([3, 4, 5, 6]);
  // Further pages only on demand.
  act(() => result.current.loadOlder());
  await flush();
  expect(getJournal).toHaveBeenLastCalledWith('t1', { before: 3, limit: 120 });
  expect(texts(result.current.items)).toEqual(['user:q1', 'assistant:a1', 'user:q2', 'assistant:a2', 'user:q3', 'assistant:a3']);
  // The journal is at its first item and this harness has no transcript: nothing more to load.
  expect(result.current.hasMore).toBe(false);
  act(() => result.current.loadOlder());
  await flush();
  expect(getJournal).toHaveBeenCalledTimes(2);
  expect(getConversation).not.toHaveBeenCalled();
});

test('older pages change to the transcript route below firstSeq', async () => {
  const { result } = renderHook(() => useStructuredChat('t1')); // Claude: the transcript holds what is older than the journal
  const getJournal = vi.spyOn(api, 'getJournal').mockResolvedValue({
    items: [row(7, userEvent('q1', { uuid: 'u-7' })), row(8, assistantEvent('a1', { uuid: 'u-8' }))], firstSeq: 7, lastSeq: 10, hasMore: false,
  });
  const getConversation = vi.spyOn(api, 'getConversation').mockResolvedValue({
    items: [{ kind: 'user', text: 'from before the journal', uuid: 'u-old', line: 3 }], cursor: 40, startLine: 3, hasMore: false,
  });
  journal(frame([row(9, userEvent('q2', { uuid: 'u-9' })), row(10, assistantEvent('a2', { uuid: 'u-10' }))], { firstSeq: 7, hasMore: true }));
  act(() => result.current.loadOlder());
  await flush();
  expect(getJournal).toHaveBeenCalledTimes(1);
  expect(getConversation).not.toHaveBeenCalled();
  expect(result.current.hasMore).toBe(true); // the journal is done; the transcript may have more
  act(() => result.current.loadOlder());
  await flush();
  // Anchored on the oldest item the view has: the transcript line of seq 7.
  expect(getConversation).toHaveBeenCalledWith('t1', { before: undefined, beforeUuid: 'u-7', limit: 120 });
  expect(getJournal).toHaveBeenCalledTimes(1);
  expect(texts(result.current.items)).toEqual(['user:from before the journal', 'user:q1', 'assistant:a1', 'user:q2', 'assistant:a2']);
  expect(result.current.hasMore).toBe(false);
});

test('items with no seq still use the fingerprint', async () => {
  // The transcript page below the journal holds the uuid copy of an echo that the journal has with no uuid.
  const { result } = renderHook(() => useStructuredChat('t1'));
  vi.spyOn(api, 'getConversation').mockResolvedValue({
    items: [
      { kind: 'user', text: 'older still', uuid: 'u-0', line: 1 },
      { kind: 'user', text: 'the echo', uuid: 'u-echo', line: 2 }, // the same message as seq 1, which has no uuid
    ], cursor: 40, startLine: 1, hasMore: false,
  });
  journal(frame([row(1, userEvent('the echo')), row(2, assistantEvent('the answer', { uuid: 'u-2' }))], { firstSeq: 1, hasMore: false }));
  act(() => result.current.loadOlder());
  await flush();
  expect(texts(result.current.items)).toEqual(['user:older still', 'user:the echo', 'assistant:the answer']);
  expect(result.current.items.filter((i) => i.text === 'the echo')).toHaveLength(1);
});

test('a journal page that fails is tried again by the next call', async () => {
  const { result } = renderHook(() => useStructuredChat('t1', undefined, { pageableHistory: false }));
  const getJournal = vi.spyOn(api, 'getJournal').mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ items: [row(1, userEvent('q1'))], firstSeq: 1, lastSeq: 2, hasMore: false });
  journal(frame([row(2, assistantEvent('a1'))], { firstSeq: 1, hasMore: true }));
  act(() => result.current.loadOlder());
  await flush();
  expect(result.current.hasMore).toBe(true);
  expect(result.current.loadingOlder).toBe(false);
  act(() => result.current.loadOlder());
  await flush();
  expect(getJournal).toHaveBeenCalledTimes(2);
  expect(seqs(result.current.items)).toEqual([1, 2]);
});

// ---- the resume cursor ----

test('a reconnect with a cursor keeps the view and adds only the newer items', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  journal(frame([row(1, userEvent('question')), row(2, assistantEvent('answer')), row(3, resultEvent())]));
  expect(cbs.resumeAfter!()).toBe(3);
  const before = result.current.items;
  act(() => { cbs.onClose?.(); cbs.onReset?.(); }); // the socket dropped and opened again
  expect(result.current.stale).toBe(true);
  journal(frame([row(4, userEvent('sent from another device')), row(5, assistantEvent('reply'))], { reset: false, after: 3, firstSeq: 1 }));
  expect(result.current.stale).toBe(false);
  expect(seqs(result.current.items)).toEqual([1, 2, 3, 4, 5]);
  // The items the view had are the same objects: nothing was folded again.
  expect(result.current.items.slice(0, 3)).toEqual(before);
  expect(result.current.items[0]).toBe(before[0]);
  expect(cbs.resumeAfter!()).toBe(5);
});

test('a reconnect that missed nothing changes nothing', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  journal(frame([row(1, userEvent('question')), row(2, assistantEvent('answer')), row(3, resultEvent())]));
  const before = result.current.items;
  act(() => { cbs.onClose?.(); cbs.onReset?.(); });
  journal(frame([], { reset: false, after: 3, firstSeq: 1, lastSeq: 3 }));
  expect(result.current.items).toEqual(before);
  expect(result.current.stale).toBe(false);
});

test('the paging state survives a resume: the next older page goes on where it was', async () => {
  const { result } = renderHook(() => useStructuredChat('t1', undefined, { pageableHistory: false }));
  const getJournal = vi.spyOn(api, 'getJournal').mockResolvedValue({ items: [row(1, userEvent('q1')), row(2, assistantEvent('a1'))], firstSeq: 1, lastSeq: 4, hasMore: false });
  journal(frame([row(3, userEvent('q2')), row(4, resultEvent())], { firstSeq: 1, hasMore: true }));
  act(() => { cbs.onClose?.(); cbs.onReset?.(); });
  journal(frame([], { reset: false, after: 4, firstSeq: 1, lastSeq: 4 }));
  expect(result.current.hasMore).toBe(true);
  act(() => result.current.loadOlder());
  await flush();
  expect(getJournal).toHaveBeenCalledWith('t1', { before: 3, limit: 120 });
  expect(seqs(result.current.items)).toEqual([1, 2, 3, 4]);
});

test('live events move the cursor: it is the seq of the last finished item when nothing streams', () => {
  renderHook(() => useStructuredChat('t1'));
  expect(cbs.resumeAfter!()).toBeUndefined(); // nothing seen yet: no cursor, the daemon sends the newest window
  live({ ...userEvent('question'), seq: 7 });
  expect(cbs.resumeAfter!()).toBe(7);
  live({ type: 'stream_event', event: { type: 'message_start' } });
  live({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  // A block streams: the view shows text that is not a journal item yet. No cursor: a reconnect now gets the window again.
  expect(cbs.resumeAfter!()).toBeUndefined();
  live({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } } });
  expect(cbs.resumeAfter!()).toBeUndefined();
  live({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, seq: 8 }); // the stop finished the item
  expect(cbs.resumeAfter!()).toBe(8);
  live({ ...resultEvent(), seq: 9 });
  expect(cbs.resumeAfter!()).toBe(9);
});

test('live items carry the seq of their event', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  live({ ...userEvent('question'), seq: 1 });
  live({ ...assistantEvent('answer'), seq: 2 });
  live({ ...resultEvent(), seq: 3 });
  expect(seqs(result.current.items)).toEqual([1, 2, 3]);
});

// ---- a connect in the middle of a Claude message (final review of v4.5.0, C1) ----
// Claude sends each content block again as a whole `assistant` frame of ONE block, with the id of
// the message. The position of that block in the frame is always 0; its stream index is the count
// of whole frames the message had before it. The daemon gives that count with the open blocks.

const streamStart = (index: number, content_block: object) => ({ type: 'stream_event', event: { type: 'content_block_start', index, content_block } });
const streamText = (index: number, text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } });
const claudeWhole = (messageId: string, block: object, extra: object = {}) => ({ type: 'assistant', message: { id: messageId, role: 'assistant', content: [block] }, ...extra });

test('a journal connect in the middle of a Claude message (thinking, then text) shows the text once', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  // Block 0 (thinking) is finished: it is journal item 2. Block 1 (text) streams now.
  journal(frame([row(1, userEvent('question')), row(2, claudeWhole('msg_1', { type: 'thinking', thinking: 'let me think' }, { uuid: 'u-think' }))]));
  live({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' }, wholes: 1 } });
  live(streamStart(1, { type: 'text', text: '' }));
  live(streamText(1, 'The ans')); // the text so far, as one delta
  // Live from here on.
  live(streamText(1, 'wer.'));
  live({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  live(claudeWhole('msg_1', { type: 'text', text: 'The answer.' }, { uuid: 'u-text', seq: 3 }));
  live({ ...resultEvent(), seq: 4 });
  expect(texts(result.current.items)).toEqual(['user:question', 'thinking:let me think', 'assistant:The answer.', 'result:']);
  expect(result.current.items[2].uuid).toBe('u-text'); // the streamed bubble took the identity of its whole frame
});

test('a journal connect between two blocks of a Claude message shows the next block once', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  // Block 0 is finished and no block is open: the daemon still says which message is in flight.
  journal(frame([row(1, userEvent('question')), row(2, claudeWhole('msg_1', { type: 'thinking', thinking: 'let me think' }, { uuid: 'u-think' }))]));
  live({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' }, wholes: 1 } });
  live(streamStart(1, { type: 'text', text: '' }));
  live(streamText(1, 'The answer.'));
  live({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  live(claudeWhole('msg_1', { type: 'text', text: 'The answer.' }, { uuid: 'u-text', seq: 3 }));
  expect(texts(result.current.items)).toEqual(['user:question', 'thinking:let me think', 'assistant:The answer.']);
});

test('a whole Claude message from start to end: each block shows once, with its own whole frame', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  live({ ...userEvent('question'), seq: 1 });
  live({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } });
  live(streamStart(0, { type: 'thinking', thinking: '' }));
  live({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me think' } } });
  live({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  live(claudeWhole('msg_1', { type: 'thinking', thinking: 'let me think' }, { uuid: 'u-think', seq: 2 }));
  live(streamStart(1, { type: 'text', text: '' }));
  live(streamText(1, 'The answer.'));
  live({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  live(claudeWhole('msg_1', { type: 'text', text: 'The answer.' }, { uuid: 'u-text', seq: 3 }));
  expect(texts(result.current.items)).toEqual(['user:question', 'thinking:let me think', 'assistant:The answer.']);
  expect(result.current.items.map((i) => i.uuid)).toEqual([undefined, 'u-think', 'u-text']);
});

test('a whole frame that comes after the next block started finishes its own block only', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  live({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } });
  live(streamStart(0, { type: 'thinking', thinking: '' }));
  live({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me think' } } });
  live({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  live(streamStart(1, { type: 'text', text: '' }));
  live(claudeWhole('msg_1', { type: 'thinking', thinking: 'let me think' }, { uuid: 'u-think', seq: 1 })); // late
  live(streamText(1, 'The answer.'));
  live({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  live(claudeWhole('msg_1', { type: 'text', text: 'The answer.' }, { uuid: 'u-text', seq: 2 }));
  expect(texts(result.current.items)).toEqual(['thinking:let me think', 'assistant:The answer.']);
  expect(result.current.items.map((i) => i.uuid)).toEqual(['u-think', 'u-text']);
});

// ---- an image that the journal keeps outside its payload, or could not keep (final review of v4.5.0, I2) ----

test('a journal image reference renders as a picture from the image route of its thread', () => {
  const id = 'a'.repeat(64);
  const event = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'journal_image', id, media_type: 'image/png', thread: 't1' } }] } };
  expect(itemsFromEvent(event, undefined, 4)).toEqual([
    { kind: 'user', text: 'look', seq: 4 },
    { kind: 'image', imageUrl: `/api/terminals/t1/journal/images/${id}`, imageMime: 'image/png', imageAlt: undefined, imageFromUser: true, seq: 4 },
  ]);
});

test('an image that the journal could not keep shows a clear note, not nothing', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  const cut = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'cut', media_type: 'image/png' } }] }, journal_cut: true };
  journal(frame([row(1, cut), row(2, assistantEvent('I see it'))]));
  expect(result.current.items.map((i) => [i.kind, i.text ?? i.imageNote, i.imageFromUser])).toEqual([
    ['user', 'look', undefined], ['image', 'Image not kept — too large', true], ['assistant', 'I see it', undefined],
  ]);
  expect(result.current.items[1].imageUrl).toBeUndefined();
  // In a tool result too.
  const tool = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: [{ type: 'image', source: { type: 'cut', media_type: 'image/png' } }] }] } };
  expect(itemsFromEvent(tool, undefined).map((i) => [i.kind, i.imageNote])).toEqual([['tool-result', undefined], ['image', 'Image not kept — too large']]);
});

// ---- an older daemon ----

test('a daemon with no journal (no frame, no seq) works as before, and no cursor is sent', async () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  const getJournal = vi.spyOn(api, 'getJournal');
  const getConversation = vi.spyOn(api, 'getConversation').mockResolvedValue({ items: [{ kind: 'user', text: 'older', uuid: 'u-0', line: 1 }], cursor: 9, startLine: 1, hasMore: false });
  live(userEvent('question'));
  live(assistantEvent('answer', { uuid: 'u-2' }));
  live(resultEvent());
  expect(texts(result.current.items)).toEqual(['user:question', 'assistant:answer', 'result:']);
  expect(seqs(result.current.items)).toEqual([undefined, undefined, undefined]);
  expect(cbs.resumeAfter!()).toBeUndefined();
  act(() => result.current.loadOlder());
  await flush();
  expect(getJournal).not.toHaveBeenCalled();
  expect(getConversation).toHaveBeenCalledWith('t1', { before: undefined, beforeUuid: 'u-2', limit: 120 });
  expect(texts(result.current.items)[0]).toBe('user:older');
  // A reconnect replays everything again (the old path): the view is replaced, not doubled.
  act(() => { cbs.onClose?.(); cbs.onReset?.(); });
  live(userEvent('question'));
  live(assistantEvent('answer', { uuid: 'u-2' }));
  expect(texts(result.current.items)).toEqual(['user:question', 'assistant:answer']);
});

// ---- the fold of a journal item is the fold of the socket ----

describe('itemsFromEvent', () => {
  const cases: [string, any][] = [
    ['a user message', userEvent('hello', { meta: { source: 'coordinator' }, uuid: 'u-1' })],
    ['a user message as a string', { type: 'user', uuid: 'u-2', message: { role: 'user', content: 'plain string' } }],
    ['a task notification', userEvent('<task-notification><summary>Background task done</summary></task-notification>')],
    ['a user image', { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } }],
    ['assistant text', assistantEvent('an answer', { uuid: 'u-3' })],
    ['assistant thinking', { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }],
    ['a tool call', { type: 'assistant', uuid: 'u-4', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls', file_path: '/x.ts' } }] } }],
    ['a tool result', { type: 'user', uuid: 'u-5', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a.txt' }], is_error: false }] } }],
    ['a failed tool result with an image', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [{ type: 'text', text: 'boom' }, { type: 'image', source: { type: 'url', url: 'https://example.test/x.png' } }] }] } }],
    ['a result footer', { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 2, duration_ms: 900, usage: { input_tokens: 10, output_tokens: 4 } }],
    ['an error result', { type: 'result', subtype: 'error', is_error: true, result: 'It failed' }],
    ['a model switch', { type: 'system', subtype: 'model', model: 'claude-opus-5', switched: true }],
    ['a refused setting', { type: 'system', subtype: 'settings_refused', message: 'That model is not available' }],
    ['a start failure', { type: 'system', subtype: 'spawn_error', message: 'ENOENT' }],
  ];
  for (const [name, event] of cases) {
    test(`${name}: a journal item renders like the same event from the socket`, () => {
      const viaSocket = renderHook(() => useStructuredChat('t1'));
      act(() => cbs.onEvent(event));
      const socketItems = viaSocket.result.current.items;
      viaSocket.unmount();
      threadViewCache.clear();
      expect(itemsFromEvent(event, undefined)).toEqual(socketItems);
      expect(socketItems.length).toBeGreaterThan(0);
      // With a seq, each item carries it.
      expect(itemsFromEvent(event, undefined, 12).every((i) => i.seq === 12)).toBe(true);
    });
  }

  test('events that render nothing give no item', () => {
    for (const event of [
      { type: 'result', subtype: 'backfill', is_error: false },
      { type: 'system', subtype: 'init', model: 'm' },
      { type: 'system', subtype: 'model', model: 'm' }, // the connect-time model frame: no line
      { type: 'user', isSynthetic: true, message: { content: [{ type: 'text', text: 'injected' }] } },
      { type: 'assistant', message: { content: [] } },
      { type: 'journal', subtype: 'gap' },
      { type: 'journal', subtype: 'idempotency', response: { status: 204 } },
      null, 'text', 7,
    ]) expect(itemsFromEvent(event, undefined, 1)).toEqual([]);
  });
});

// ---- the resume tracker ----

describe('ResumeTracker', () => {
  const start = (index: number, parent?: string) => ({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, ...(parent ? { parent_tool_use_id: parent } : {}) });
  const messageStart = (id?: string) => ({ type: 'stream_event', event: { type: 'message_start', ...(id ? { message: { id } } : {}) } });

  test('no cursor before a finished item, then the seq of the last one', () => {
    const t = new ResumeTracker();
    expect(t.cursor()).toBeUndefined();
    expect(t.note({ type: 'system', subtype: 'init' })).toBeUndefined();
    expect(t.note({ ...userEvent('q'), seq: 4 })).toBe(4);
    expect(t.cursor()).toBe(4);
  });

  test('Codex and ACP: a block is finished by its stop with a seq', () => {
    const t = new ResumeTracker();
    t.note({ ...userEvent('q'), seq: 1 });
    t.note(messageStart());
    t.note(start(0));
    expect(t.cursor()).toBeUndefined();
    t.note({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, seq: 2 });
    expect(t.cursor()).toBe(2);
  });

  test('a block that gets no seq (Codex reasoning) holds the cursor back until the result', () => {
    const t = new ResumeTracker();
    t.note(messageStart());
    t.note(start(0)); // reasoning: no stop comes
    t.note(start(1));
    t.note({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 }, seq: 5 });
    expect(t.cursor()).toBeUndefined(); // block 0 is on screen and not in the journal yet
    t.note({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Shell', input: {} }] }, seq: 6 });
    expect(t.cursor()).toBeUndefined(); // a whole frame of another kind does not finish block 0
    t.note({ ...resultEvent(), seq: 8 });
    expect(t.cursor()).toBe(8); // the turn end finished every block
  });

  test('Claude: the whole frames of the message that streams finish its blocks, one each', () => {
    const t = new ResumeTracker();
    t.note(messageStart('msg_1'));
    t.note(start(0));
    t.note(start(1));
    t.note({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'a' }] }, seq: 3 });
    expect(t.cursor()).toBeUndefined(); // block 1 still streams
    t.note({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] }, seq: 4 });
    expect(t.cursor()).toBe(4);
  });

  test('a result with no seq (the daemon\'s own settle) finishes nothing', () => {
    const t = new ResumeTracker();
    t.note({ ...userEvent('q'), seq: 1 });
    t.note(messageStart());
    t.note(start(0));
    t.note({ type: 'result', subtype: 'backfill', is_error: false });
    expect(t.cursor()).toBeUndefined();
  });

  test('synced sets the cursor to the frame and forgets open blocks', () => {
    const t = new ResumeTracker();
    t.note(messageStart());
    t.note(start(0));
    t.synced(12);
    expect(t.cursor()).toBe(12);
    t.note(start(0)); // the tail of the replay: a block streams
    expect(t.cursor()).toBeUndefined();
    t.reset();
    expect(t.cursor()).toBeUndefined();
  });
});

// ---- newest first (2026-11-12): a small first window, one fill page, older pages on demand ----

describe('newest first', () => {
  const rows = (from: number, to: number) => {
    const out: JournalItem[] = [];
    for (let s = from; s <= to; s++) out.push(row(s, s % 2 ? userEvent(`q${s}`) : assistantEvent(`a${s}`)));
    return out;
  };

  test('the first window shows at once; one page fills it up to FILL_TARGET, before the oldest seq', async () => {
    const { result } = renderHook(() => useStructuredChat('t1', undefined, { pageableHistory: false }));
    let resolve!: (p: any) => void;
    const getJournal = vi.spyOn(api, 'getJournal').mockReturnValue(new Promise((r) => { resolve = r; }) as any);
    journal(frame(rows(941, 1000), { firstSeq: 1, hasMore: true }));
    // The newest 60 are on screen before any page answers.
    expect(result.current.items).toHaveLength(60);
    expect(seqs(result.current.items).at(-1)).toBe(1000);
    expect(getJournal).toHaveBeenCalledTimes(1);
    expect(getJournal).toHaveBeenCalledWith('t1', { before: 941, limit: FILL_TARGET - 60 });
    expect(result.current.loadingOlder).toBe(true); // the quiet pill
    // A live item lands while the page is on its way: it goes at the end.
    live({ ...userEvent('live one'), seq: 1001 });
    resolve({ items: rows(801, 940), firstSeq: 1, lastSeq: 1001, hasMore: true });
    await flush();
    const s = seqs(result.current.items);
    expect(s).toHaveLength(201);
    expect(s[0]).toBe(801);
    expect(s.at(-1)).toBe(1001);
    expect([...s].sort((a, b) => a! - b!)).toEqual(s); // in sequence order: nothing reordered
    expect(new Set(s).size).toBe(s.length);            // nothing twice
    expect(result.current.loadingOlder).toBe(false);
    expect(result.current.hasMore).toBe(true);
    // No more pages until the person asks.
    await flush();
    expect(getJournal).toHaveBeenCalledTimes(1);
  });

  test('no fill when the window is the whole journal, and none on a reconnect that keeps the view', async () => {
    const { result } = renderHook(() => useStructuredChat('t1', undefined, { pageableHistory: false }));
    const getJournal = vi.spyOn(api, 'getJournal').mockResolvedValue({ items: [], firstSeq: 1, lastSeq: 3, hasMore: false });
    journal(frame(rows(1, 3), { firstSeq: 1, hasMore: false }));
    journal(frame(rows(4, 5), { reset: false, after: 3, firstSeq: 1, hasMore: false }));
    await flush();
    expect(getJournal).not.toHaveBeenCalled();
    expect(result.current.hasMore).toBe(false); // the view is the start of the thread
  });

  test('a fill asked for by a socket that was replaced since is dropped', async () => {
    const { result } = renderHook(() => useStructuredChat('t1', undefined, { pageableHistory: false }));
    let resolve!: (p: any) => void;
    vi.spyOn(api, 'getJournal').mockReturnValue(new Promise((r) => { resolve = r; }) as any);
    journal(frame(rows(41, 100), { firstSeq: 1, hasMore: true }));
    act(() => cbs.onReset!()); // the socket reconnects: its replay replaces the view
    journal(frame(rows(51, 110), { firstSeq: 1, hasMore: false }));
    resolve({ items: rows(1, 40), firstSeq: 1, lastSeq: 110, hasMore: false });
    await flush();
    expect(seqs(result.current.items)[0]).toBe(51); // the old page did not land
  });

  test('prependJournalRows: rows the view has already are not added again; order is kept', () => {
    const prev = itemsFromEvent(userEvent('q5'), undefined, 5).concat(itemsFromEvent(assistantEvent('a6'), undefined, 6));
    const next = prependJournalRows(prev, [row(4, assistantEvent('a4')), row(5, userEvent('q5'))], undefined);
    expect(seqs(next)).toEqual([4, 5, 6]);
    expect(prependJournalRows(prev, [row(5, userEvent('q5'))], undefined)).toBe(prev); // nothing new: the same array
  });

  test('a question card does not depend on the window: the permission frame shows it with its request far above', () => {
    const { result } = renderHook(() => useStructuredChat('t1'));
    journal(frame(rows(941, 1000), { firstSeq: 1, hasMore: false }));
    const pending = { requestId: 'r1', toolName: 'AskUserQuestion', toolUseId: 'tu-old', questions: [{ question: 'Which?', options: ['A', 'B'] }] };
    act(() => cbs.onEvent({ type: 'permission', pending }));
    expect(result.current.items.some((i) => i.toolId === 'tu-old')).toBe(false); // its tool call is not in the window
    expect(result.current.pending?.requestId).toBe('r1');
  });
});
