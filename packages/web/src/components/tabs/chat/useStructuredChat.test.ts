// packages/web/src/components/tabs/chat/useStructuredChat.test.ts
import { renderHook, act } from '@testing-library/react';
import { test, expect, vi, beforeEach } from 'vitest';
import { useStructuredChat } from './useStructuredChat';
import * as sock from '../../../api/structured-socket';
import { api, type ContentBlock } from '../../../api/client';

// Captures the socket callbacks so a test can drive events directly.
interface Cbs { onEvent: (e: any) => void; onReset?: () => void; onClose?: () => void }
let cbs: Cbs;
function mockSocket() {
  vi.spyOn(sock, 'openStructuredSocket').mockImplementation((opts: any) => {
    cbs = opts;
    return { close: () => {} };
  });
}

// Delta rendering is now coalesced into a single requestAnimationFrame flush, so
// deltas don't render synchronously. We capture the scheduled rAF callbacks and run
// them on demand via flushRaf() to validate the batched-but-incremental streaming.
let rafCbs: FrameRequestCallback[] = [];
function flushRaf() {
  const due = rafCbs;
  rafCbs = [];
  act(() => { for (const cb of due) cb(0); });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rafCbs = [];
  // Deferred rAF: queue the callback (returns a non-null handle) until flushRaf runs it.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafCbs.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  mockSocket();
});

// Stream-event helpers
const start = (index: number, content_block: any) => ({ type: 'stream_event', event: { type: 'content_block_start', index, content_block } });
const textDelta = (index: number, text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } });
const thinkDelta = (index: number, thinking: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } } });
const jsonDelta = (index: number, partial_json: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } } });

test('streams assistant text incrementally and ignores the whole assistant event (no dup)', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'text' })));
  // bubble appears immediately at content_block_start (empty), busy true — no flush needed
  expect(result.current.busy).toBe(true);
  expect(result.current.items.filter((i) => i.kind === 'assistant')).toHaveLength(1);
  act(() => cbs.onEvent(textDelta(0, 'Hel')));
  flushRaf();
  let txt = result.current.items.filter((i) => i.kind === 'assistant');
  expect(txt).toHaveLength(1);
  expect(txt[0].text).toBe('Hel');
  act(() => cbs.onEvent(textDelta(0, 'lo!')));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }));
  // whole assistant event must NOT add a second bubble, and the trailing 'lo!' (still
  // buffered) must not be lost — the assistant handler flushes it before reconciling.
  act(() => cbs.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello!' }] } }));
  txt = result.current.items.filter((i) => i.kind === 'assistant');
  expect(txt).toHaveLength(1);
  expect(txt[0].text).toBe('Hello!');
});

test('coalesces multiple deltas into a single rAF flush', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'text' })));
  act(() => cbs.onEvent(textDelta(0, 'a')));
  act(() => cbs.onEvent(textDelta(0, 'b')));
  act(() => cbs.onEvent(textDelta(0, 'c')));
  // three deltas → exactly ONE scheduled flush, text not yet applied
  expect(rafCbs).toHaveLength(1);
  expect(result.current.items.find((i) => i.kind === 'assistant')?.text).toBe('');
  flushRaf();
  expect(result.current.items.find((i) => i.kind === 'assistant')?.text).toBe('abc');
});

test('streams thinking deltas into a single thinking item', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'thinking' })));
  act(() => cbs.onEvent(thinkDelta(0, 'let me ')));
  act(() => cbs.onEvent(thinkDelta(0, 'think')));
  flushRaf();
  const think = result.current.items.filter((i) => i.kind === 'thinking');
  expect(think).toHaveLength(1);
  expect(think[0].text).toBe('let me think');
});

test('streams tool_use args, reconciles parsed input, and pairs the tool_result', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'tool_use', name: 'Read', id: 'tu-1' })));
  // tool bubble exists immediately (name/id) before any args flush
  expect(result.current.items.find((i) => i.kind === 'tool')?.toolName).toBe('Read');
  act(() => cbs.onEvent(jsonDelta(0, '{"file_path":')));
  act(() => cbs.onEvent(jsonDelta(0, '"/a/b.ts"}')));
  flushRaf();
  let tool = result.current.items.find((i) => i.kind === 'tool');
  expect(tool?.toolName).toBe('Read');
  expect(tool?.toolId).toBe('tu-1');
  // accum is now complete JSON → toolFile resolves
  expect(tool?.toolFile).toBe('/a/b.ts');
  // whole assistant reconciles the parsed input (pretty JSON), no duplicate tool
  act(() => cbs.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 'tu-1', input: { file_path: '/a/b.ts' } }] } }));
  expect(result.current.items.filter((i) => i.kind === 'tool')).toHaveLength(1);
  tool = result.current.items.find((i) => i.kind === 'tool');
  expect(tool?.toolInput).toContain('"/a/b.ts"');
  // tool_result still comes from a user event, paired by id
  act(() => cbs.onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file body', is_error: false }] } }));
  const tr = result.current.items.find((i) => i.kind === 'tool-result');
  expect(tr?.toolId).toBe('tu-1');
  expect(tr?.text).toBe('file body');
});

test('maps an echoed user text block to a user bubble (P0a)', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi claude' }] } }));
  const u = result.current.items.find((i) => i.kind === 'user');
  expect(u?.text).toBe('hi claude');
});

test('maps a STRING-content user turn (transcript backfill on resume) to a user bubble', () => {
  // After a daemon restart the chat is rebuilt from the transcript, where a human turn's
  // content is a plain string (not an array). It must still render as a user bubble — the
  // old Array.isArray-only handler dropped these, so the user's messages vanished on resume.
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: 'hello after restart' } }));
  const u = result.current.items.find((i) => i.kind === 'user');
  expect(u?.text).toBe('hello after restart');
});

test('result event populates the footer and clears busy', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  expect(result.current.busy).toBe(true);
  act(() => cbs.onEvent({ type: 'result', is_error: false, total_cost_usd: 0.27, num_turns: 2, duration_ms: 8500, usage: { input_tokens: 100, output_tokens: 200 } }));
  expect(result.current.busy).toBe(false);
  const r = result.current.items.find((i) => i.kind === 'result');
  expect(r).toMatchObject({ costUsd: 0.27, turns: 2, durationMs: 8500, tokensIn: 100, tokensOut: 200, isError: false });
});

test('result flushes buffered trailing text before appending the footer (no lost tokens)', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'text' })));
  act(() => cbs.onEvent(textDelta(0, 'done')));
  // result arrives before the rAF frame fires — the buffered 'done' must still land
  act(() => cbs.onEvent({ type: 'result', is_error: false, num_turns: 1, duration_ms: 10 }));
  const txt = result.current.items.filter((i) => i.kind === 'assistant');
  expect(txt).toHaveLength(1);
  expect(txt[0].text).toBe('done');
  expect(result.current.items.find((i) => i.kind === 'result')).toBeTruthy();
});

test('system/init sets the model', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'system', subtype: 'init', model: 'claude-x' }));
  expect(result.current.model).toBe('claude-x');
});

test('fallback: whole assistant handling when no stream_events ever arrive', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'plain' }, { type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'ls' } }] } }));
  expect(result.current.items.find((i) => i.kind === 'assistant' && i.text === 'plain')).toBeTruthy();
  expect(result.current.items.find((i) => i.kind === 'tool' && i.toolName === 'Bash')).toBeTruthy();
});

test('send sets busy and does NOT optimistically append a user bubble', () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => { result.current.send('hello'); });
  expect(result.current.busy).toBe(true);
  expect(result.current.items.filter((i) => i.kind === 'user')).toHaveLength(0); // no optimistic dup
  expect(api.sendStructuredMessage).toHaveBeenCalledWith('t1', 'hello');
});

test('send accepts a content-block array (image) and threads it to the API verbatim', () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  const blocks: ContentBlock[] = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }];
  act(() => { result.current.send(blocks); });
  expect(result.current.busy).toBe(true);
  // No optimistic bubble: the backend echoes the image turn (and it survives reconnect replay).
  expect(result.current.items.filter((i) => i.kind === 'user')).toHaveLength(0);
  expect(result.current.items.filter((i) => i.kind === 'image')).toHaveLength(0);
  expect(api.sendStructuredMessage).toHaveBeenCalledWith('t1', blocks);
});

test('send ignores an EMPTY content-block array (no API call, stays idle)', () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => { result.current.send([]); });
  expect(result.current.busy).toBe(false);
  expect(api.sendStructuredMessage).not.toHaveBeenCalled();
});

test('send POST rejection clears busy and appends an error result (P0c)', async () => {
  vi.spyOn(api, 'sendStructuredMessage').mockRejectedValue(new Error('400'));
  const { result } = renderHook(() => useStructuredChat('t1'));
  await act(async () => { result.current.send('hello'); await Promise.resolve(); });
  expect(result.current.busy).toBe(false);
  const err = result.current.items.find((i) => i.kind === 'result' && i.isError && i.text === 'Failed to send message');
  expect(err).toBeTruthy();
});

test('onClose clears busy (P0b safety net)', () => {
  vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => { result.current.send('hello'); });
  expect(result.current.busy).toBe(true);
  act(() => cbs.onClose?.());
  expect(result.current.busy).toBe(false);
});

test('tags a human-attached image on the user turn with imageFromUser (BUG 3)', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: 'what is this?' },
  ] } }));
  const img = result.current.items.find((i) => i.kind === 'image');
  expect(img?.imageFromUser).toBe(true); // → attributed to "You" downstream
  expect(img?.imageUrl).toBe('data:image/png;base64,AAAA');
});

test('does NOT tag tool_result / assistant images as imageFromUser (BUG 3 boundary)', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  // a tool-emitted screenshot nested in a tool_result (arrives on a `user` event)
  act(() => cbs.onEvent({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } }] },
  ] } }));
  // an assistant-emitted image (e.g. post_image)
  act(() => cbs.onEvent({ type: 'assistant', message: { content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCCC' } },
  ] } }));
  const imgs = result.current.items.filter((i) => i.kind === 'image');
  expect(imgs).toHaveLength(2);
  expect(imgs.every((i) => !i.imageFromUser)).toBe(true); // neither is the human's own turn
});

test('a permission frame surfaces the pending AskUserQuestion and stops the working spinner', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  // The assistant emitted the AskUserQuestion tool_use → busy is true, thread blocked on stdin.
  act(() => cbs.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'tu-9', input: { questions: [] } }] } }));
  expect(result.current.busy).toBe(true);
  const pending = { requestId: 'req-9', toolName: 'AskUserQuestion', toolUseId: 'tu-9', questions: [{ question: 'Pick one', header: 'Choice', options: ['A', 'B'], multiSelect: false }] };
  act(() => cbs.onEvent({ type: 'permission', pending }));
  expect(result.current.pending?.requestId).toBe('req-9');
  expect(result.current.pending?.questions?.[0]?.question).toBe('Pick one');
  // We're now waiting on the HUMAN, not the model — the "Working…" spinner must stop.
  expect(result.current.busy).toBe(false);
});

test('answer() POSTs allow with the answers map (keyed by question text) and clears pending + resumes busy', () => {
  const spy = vi.spyOn(api, 'answerPermission').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  const pending = { requestId: 'req-9', toolName: 'AskUserQuestion', toolUseId: 'tu-9', questions: [{ question: 'Pick one', header: 'Choice', options: ['A', 'B'], multiSelect: false }] };
  act(() => cbs.onEvent({ type: 'permission', pending }));
  act(() => { result.current.answer({ 'Pick one': 'A' }); });
  expect(spy).toHaveBeenCalledWith('t1', { requestId: 'req-9', decision: 'allow', answers: { 'Pick one': 'A' } });
  expect(result.current.pending).toBeNull();
  // The thread is unblocked and working again → spinner resumes until the next result.
  expect(result.current.busy).toBe(true);
});

test('the AskUserQuestion tool_result clears any lingering pending (answered / resumed elsewhere)', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  const pending = { requestId: 'req-9', toolName: 'AskUserQuestion', toolUseId: 'tu-9', questions: [{ question: 'Pick one', options: ['A'] }] };
  act(() => cbs.onEvent({ type: 'permission', pending }));
  expect(result.current.pending).not.toBeNull();
  act(() => cbs.onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-9', content: 'answered' }] } }));
  expect(result.current.pending).toBeNull();
});

test('a reconnect reset clears pending (stale question not re-shown before replay)', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'permission', pending: { requestId: 'req-9', toolName: 'AskUserQuestion', toolUseId: 'tu-9', questions: [{ question: 'Q', options: ['A'] }] } }));
  expect(result.current.pending).not.toBeNull();
  act(() => cbs.onReset?.());
  expect(result.current.pending).toBeNull();
});

test('resolves a PATH-form image via the byte route ONLY when sessionId is wired (BUG 2)', () => {
  // With a sessionId the path resolves to the sandboxed byte route…
  const withSession = renderHook(() => useStructuredChat('t1', 'sess-1'));
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: [
    { type: 'image', source: { path: '/inbox/pic.png' } },
  ] } }));
  const img = withSession.result.current.items.find((i) => i.kind === 'image');
  expect(img?.imageUrl).toBe(api.imageUrl('sess-1', '/inbox/pic.png'));

  // …without one (the pre-fix coordinator path) the same block is DROPPED.
  const noSession = renderHook(() => useStructuredChat('t2'));
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: [
    { type: 'image', source: { path: '/inbox/pic.png' } },
  ] } }));
  expect(noSession.result.current.items.filter((i) => i.kind === 'image')).toHaveLength(0);
});
