// W2-I: thread open and action latency. The view cache (a switch back shows content at once), the
// optimistic user bubble, and a reconnect that does not empty the view.
import { renderHook, act } from '@testing-library/react';
import { test, expect, vi, beforeEach } from 'vitest';
import { useStructuredChat } from './useStructuredChat';
import * as sock from '../../../api/structured-socket';
import { api, ApiError } from '../../../api/client';
import { threadViewCache } from '../../../lib/threadViewCache';
import type { ConvItem } from '../../../api/types';

interface Cbs { onEvent: (e: any) => void; onReset?: () => void; onClose?: () => void; onReplayEnd?: () => void }
let cbs: Cbs;
let opened = 0;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  threadViewCache.clear();
  opened = 0;
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation((opts: any) => { cbs = opts; opened++; return { close: () => {} }; });
});

const userEcho = (text: string, extra: object = {}) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, meta: { source: 'user' }, ...extra });
const assistant = (text: string, uuid: string) => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });
const users = (items: ConvItem[]) => items.filter((i) => i.kind === 'user');
const texts = (items: ConvItem[]) => items.map((i) => `${i.kind}:${i.text ?? ''}`);
/** A replay as the socket delivers a batch frame: every event in one task, then the end mark. */
const replay = (events: unknown[]) => act(() => { for (const e of events) cbs.onEvent(e); cbs.onReplayEnd?.(); });

// ---- the view cache ----

test('a switch back shows cached items before the socket opens', () => {
  const first = renderHook(() => useStructuredChat('t1'));
  replay([userEcho('question one'), assistant('answer one', 'a1')]);
  expect(texts(first.result.current.items)).toEqual(['user:question one', 'assistant:answer one']);
  first.unmount(); // the tab switch: the view goes away

  let rendersWithContent = 0;
  let renders = 0;
  const back = renderHook(() => { const c = useStructuredChat('t1'); renders++; if (c.items.length) rendersWithContent++; return c; });
  // The very FIRST render has the content (the same frame as the switch), not a later one.
  expect(renders).toBe(rendersWithContent);
  expect(texts(back.result.current.items)).toEqual(['user:question one', 'assistant:answer one']);
  expect(back.result.current.stale).toBe(true);
  // No event has arrived: the socket was only asked for. No older page is offered from a stale view.
  expect(back.result.current.hasMore).toBe(false);
});

test('a thread never opened shows nothing and is not stale', () => {
  const { result } = renderHook(() => useStructuredChat('t9'));
  expect(result.current.items).toEqual([]);
  expect(result.current.stale).toBe(false);
  expect(result.current.hasMore).toBe(true);
});

test('a replay replaces cached items with no duplicate', () => {
  const first = renderHook(() => useStructuredChat('t1'));
  replay([userEcho('question one'), assistant('answer one', 'a1')]);
  first.unmount();
  const back = renderHook(() => useStructuredChat('t1'));
  // The replay holds what the cache held, plus what happened while the view was away.
  replay([userEcho('question one'), assistant('answer one', 'a1'), userEcho('question two'), assistant('answer two', 'a2')]);
  expect(texts(back.result.current.items)).toEqual(['user:question one', 'assistant:answer one', 'user:question two', 'assistant:answer two']);
  expect(back.result.current.stale).toBe(false);
  expect(back.result.current.hasMore).toBe(true); // paging is armed again from the fresh tail
});

test('a replay with nothing to render keeps the cached items until the REST page arrives, then replaces them', async () => {
  threadViewCache.put('t1', [{ kind: 'user', text: 'old question', uuid: 'u1' }, { kind: 'assistant', text: 'old answer', uuid: 'a1' }]);
  let resolve!: (v: any) => void;
  vi.spyOn(api, 'getConversation').mockReturnValue(new Promise((r) => { resolve = r; }) as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  replay([{ type: 'system', subtype: 'inactive' }, { type: 'system', subtype: 'model', model: 'm' }]);
  expect(texts(result.current.items)).toEqual(['user:old question', 'assistant:old answer']); // not emptied while REST is on its way
  expect(result.current.stale).toBe(true);
  await act(async () => { resolve({ items: [{ kind: 'user', text: 'old question', uuid: 'u1' }, { kind: 'assistant', text: 'old answer', uuid: 'a1' }, { kind: 'assistant', text: 'newer', uuid: 'a2' }], cursor: 9, startLine: 3, hasMore: true }); });
  expect(texts(result.current.items)).toEqual(['user:old question', 'assistant:old answer', 'assistant:newer']);
  expect(result.current.stale).toBe(false);
});

test('the cache keeps the view of the thread that was left, not of the one that is opened', () => {
  const h = renderHook(({ id }) => useStructuredChat(id), { initialProps: { id: 'a' } });
  replay([assistant('in a', 'a1')]);
  h.rerender({ id: 'b' });
  expect(h.result.current.items).toEqual([]); // b was never seen
  replay([assistant('in b', 'b1')]);
  h.rerender({ id: 'a' });
  expect(texts(h.result.current.items)).toEqual(['assistant:in a']);
  expect(h.result.current.stale).toBe(true);
  expect(threadViewCache.get('b')?.map((i) => i.text)).toEqual(['in b']);
});

test('a view closed before its replay arrived does not overwrite the cache with nothing', () => {
  threadViewCache.put('t1', [{ kind: 'assistant', text: 'kept', uuid: 'a1' }]);
  const h = renderHook(() => useStructuredChat('t1'));
  h.unmount();
  expect(threadViewCache.get('t1')?.map((i) => i.text)).toEqual(['kept']);
});

// ---- a reconnect does not empty the view ----

test('a reconnect keeps the items on screen (stale) and the replay replaces them with no duplicate', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  replay([userEcho('q'), assistant('a', 'a1')]);
  act(() => cbs.onClose?.());
  act(() => cbs.onReset?.());
  expect(texts(result.current.items)).toEqual(['user:q', 'assistant:a']);
  expect(result.current.stale).toBe(true);
  replay([userEcho('q'), assistant('a', 'a1'), assistant('more', 'a2')]);
  expect(texts(result.current.items)).toEqual(['user:q', 'assistant:a', 'assistant:more']);
  expect(result.current.stale).toBe(false);
});

test('an older daemon (single frames, no end mark): the first frame of the replay replaces the stale items', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent(userEcho('q')));
  act(() => cbs.onEvent(assistant('a', 'a1')));
  act(() => cbs.onReset?.());
  act(() => cbs.onEvent(userEcho('q')));
  expect(texts(result.current.items)).toEqual(['user:q']);
  act(() => cbs.onEvent(assistant('a', 'a1')));
  expect(texts(result.current.items)).toEqual(['user:q', 'assistant:a']);
});

// ---- the optimistic user bubble ----

test('a sent message shows before the echo, and the echo does not add a second one', async () => {
  let resolvePost!: () => void;
  const post = vi.spyOn(api, 'sendStructuredMessage').mockReturnValue(new Promise<void>((r) => { resolvePost = r; }) as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => result.current.send('hello there'));
  // In the same act as the send: the bubble is there and the request has not answered.
  expect(users(result.current.items)).toHaveLength(1);
  expect(users(result.current.items)[0]).toMatchObject({ text: 'hello there', sendState: 'sending' });
  expect(users(result.current.items)[0].localId).toBeTruthy();
  expect(post).toHaveBeenCalledWith('t1', 'hello there');
  const keyBefore = users(result.current.items)[0].uuid;
  act(() => cbs.onEvent(userEcho('hello there')));
  expect(users(result.current.items)).toHaveLength(1);
  expect(users(result.current.items)[0].localId).toBeUndefined();
  expect(users(result.current.items)[0].sendState).toBeUndefined();
  expect(users(result.current.items)[0].source).toBe('user');
  expect(users(result.current.items)[0].uuid).toBe(keyBefore); // the same row key: the bubble is not remounted
  await act(async () => { resolvePost(); });
  expect(users(result.current.items)).toHaveLength(1);
});

test('no duplicate bubble when the echo arrives with different whitespace', () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => result.current.send('line one\n\n  line   two  '));
  expect(users(result.current.items)).toHaveLength(1);
  act(() => cbs.onEvent(userEcho('line one\nline two\n')));
  expect(users(result.current.items)).toHaveLength(1);
  expect(users(result.current.items)[0].text).toBe('line one\nline two\n'); // the server's text wins
  expect(users(result.current.items)[0].localId).toBeUndefined();
});

test('an echo whose content is a string (a transcript backfill) replaces the bubble too', () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => result.current.send('plain'));
  act(() => cbs.onEvent({ type: 'user', uuid: 'real-1', message: { role: 'user', content: 'plain' } }));
  expect(users(result.current.items)).toHaveLength(1);
  expect(users(result.current.items)[0].uuid).toBe('real-1');
});

test('two sends of the same text keep two bubbles, and two echoes replace one each', () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => result.current.send('again'));
  act(() => result.current.send('again'));
  expect(users(result.current.items)).toHaveLength(2);
  act(() => cbs.onEvent(userEcho('again')));
  expect(users(result.current.items).filter((i) => i.localId)).toHaveLength(1);
  act(() => cbs.onEvent(userEcho('again')));
  expect(users(result.current.items)).toHaveLength(2);
  expect(users(result.current.items).filter((i) => i.localId)).toHaveLength(0);
});

test('a user turn from somewhere else (another device, the coordinator) does not replace a different local bubble', () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => result.current.send('mine'));
  act(() => cbs.onEvent(userEcho('theirs')));
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'mine' }] }, meta: { source: 'coordinator' } }));
  expect(texts(users(result.current.items))).toEqual(['user:mine', 'user:theirs', 'user:mine']);
  expect(users(result.current.items)[0].localId).toBeTruthy();
});

test('a failed POST marks the bubble', async () => {
  vi.spyOn(api, 'sendStructuredMessage').mockRejectedValue(new ApiError(400, 'process is not running'));
  const { result } = renderHook(() => useStructuredChat('t1'));
  await act(async () => { result.current.send('will fail'); });
  const u = users(result.current.items);
  expect(u).toHaveLength(1);
  expect(u[0].sendState).toBe('failed');
  expect(result.current.busy).toBe(false);
  // The reason still shows in the timeline, as before.
  expect(result.current.items.some((i) => i.kind === 'result' && i.isError)).toBe(true);
});

test('retry of a failed bubble sends the same content again and shows one bubble', async () => {
  const post = vi.spyOn(api, 'sendStructuredMessage').mockRejectedValueOnce(new ApiError(502, 'bad gateway')).mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  await act(async () => { result.current.send('try me'); });
  const failed = users(result.current.items)[0];
  await act(async () => { result.current.retrySend(failed.localId!); });
  expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[1]).toEqual(['t1', 'try me']);
  const u = users(result.current.items);
  expect(u).toHaveLength(1);
  expect(u[0].sendState).not.toBe('failed');
  act(() => cbs.onEvent(userEcho('try me')));
  expect(users(result.current.items)).toHaveLength(1);
  expect(users(result.current.items)[0].localId).toBeUndefined();
});

test('a POST that succeeds with no echo yet leaves a plain bubble (no "sending" for ever)', async () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  await act(async () => { result.current.send('accepted'); });
  expect(users(result.current.items)[0].sendState).toBeUndefined();
  expect(users(result.current.items)[0].localId).toBeTruthy(); // still waits for its echo
});

test('a send while the socket is reconnecting: the bubble stays through the reset, and the replay echo replaces it once, in its place', async () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  replay([userEcho('first'), assistant('reply', 'a1')]);
  act(() => cbs.onClose?.()); // the socket dropped; it reconnects with backoff
  await act(async () => { result.current.send('sent while offline'); });
  expect(texts(result.current.items)).toEqual(['user:first', 'assistant:reply', 'user:sent while offline']);
  act(() => cbs.onReset?.()); // the new socket opened
  expect(texts(result.current.items)).toEqual(['user:first', 'assistant:reply', 'user:sent while offline']);
  // The daemon got the POST, so the replay holds the echo and the reply that followed.
  replay([userEcho('first'), assistant('reply', 'a1'), userEcho('sent while offline'), assistant('second reply', 'a2')]);
  expect(texts(result.current.items)).toEqual(['user:first', 'assistant:reply', 'user:sent while offline', 'assistant:second reply']);
  expect(result.current.items.some((i) => i.localId)).toBe(false);
});

test('a send while reconnecting whose POST has not reached the daemon: the bubble is kept under the replay', async () => {
  vi.spyOn(api, 'sendStructuredMessage').mockReturnValue(new Promise(() => {}) as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  replay([userEcho('first'), assistant('reply', 'a1')]);
  act(() => cbs.onClose?.());
  act(() => result.current.send('still on its way'));
  act(() => cbs.onReset?.());
  replay([userEcho('first'), assistant('reply', 'a1')]); // no echo yet
  expect(texts(result.current.items)).toEqual(['user:first', 'assistant:reply', 'user:still on its way']);
  act(() => cbs.onEvent(userEcho('still on its way'))); // then it arrives live
  expect(texts(result.current.items)).toEqual(['user:first', 'assistant:reply', 'user:still on its way']);
  expect(result.current.items.some((i) => i.localId)).toBe(false);
});

test('a block message with text and an image: one local bubble for the text, replaced by the echo', () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  const blocks = [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] as any;
  act(() => result.current.send(blocks));
  expect(users(result.current.items)).toHaveLength(1);
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: blocks }, meta: { source: 'user' } }));
  expect(users(result.current.items)).toHaveLength(1);
  expect(users(result.current.items)[0].localId).toBeUndefined();
  expect(result.current.items.filter((i) => i.kind === 'image')).toHaveLength(1);
});

test('a slash command gets no local bubble (the daemon runs it; it may send no echo)', () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => result.current.send('/model'));
  expect(users(result.current.items)).toHaveLength(0);
  expect(result.current.busy).toBe(true);
});

test('an unsent local bubble is not kept in the cache', () => {
  vi.spyOn(api, 'sendStructuredMessage').mockReturnValue(new Promise(() => {}) as any);
  const h = renderHook(() => useStructuredChat('t1'));
  replay([assistant('a', 'a1')]);
  act(() => h.result.current.send('pending'));
  h.unmount();
  expect(threadViewCache.get('t1')?.map((i) => i.text)).toEqual(['a']);
});
