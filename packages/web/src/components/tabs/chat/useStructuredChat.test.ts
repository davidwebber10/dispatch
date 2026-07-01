// packages/web/src/components/tabs/chat/useStructuredChat.test.ts
import { renderHook, act } from '@testing-library/react';
import { test, expect, vi, beforeEach } from 'vitest';
import { useStructuredChat, contextWindowFor } from './useStructuredChat';
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
// Assistant/thinking text now reveals gradually across several frames (each frame
// closes ~30% of the remaining gap — see REVEAL_CATCHUP in useStructuredChat.ts)
// instead of snapping to the full text in one flush. Tests that only care about the
// FINAL settled text should drain every frame the reveal animation schedules.
function drainRaf(maxFrames = 50) {
  let n = 0;
  while (rafCbs.length && n++ < maxFrames) flushRaf();
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

test('contextWindowFor returns 1M for sonnet/opus and 200k for haiku (undefined defaults to 1M)', () => {
  expect(contextWindowFor('claude-sonnet-5')).toBe(1_000_000);
  expect(contextWindowFor('claude-opus-4-8')).toBe(1_000_000);
  expect(contextWindowFor('claude-haiku-4-5-20251001')).toBe(200_000);
  expect(contextWindowFor(undefined)).toBe(1_000_000);
});

test('streams assistant text incrementally and ignores the whole assistant event (no dup)', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'text' })));
  // bubble appears immediately at content_block_start (empty), busy true — no flush needed
  expect(result.current.busy).toBe(true);
  expect(result.current.items.filter((i) => i.kind === 'assistant')).toHaveLength(1);
  act(() => cbs.onEvent(textDelta(0, 'Hel')));
  drainRaf();
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
  drainRaf();
  expect(result.current.items.find((i) => i.kind === 'assistant')?.text).toBe('abc');
});

test('reveals bursty text gradually across frames instead of snapping to it (smoothing fix)', () => {
  // The CLI delivers text in bursts (not a steady per-token trickle) — snapping the
  // whole burst in on the very next frame reads as choppy pop-in. A big burst should
  // reveal over multiple frames, landing on the full text once the animation settles.
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'text' })));
  act(() => cbs.onEvent(textDelta(0, 'a'.repeat(100))));
  flushRaf(); // exactly one frame of the reveal animation
  const afterOneFrame = result.current.items.find((i) => i.kind === 'assistant')?.text ?? '';
  expect(afterOneFrame.length).toBeGreaterThan(0);
  expect(afterOneFrame.length).toBeLessThan(100); // not snapped straight to the full burst
  drainRaf(); // let the catch-up animation finish
  expect(result.current.items.find((i) => i.kind === 'assistant')?.text).toBe('a'.repeat(100));
});

test('streams thinking deltas into a single thinking item', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'thinking' })));
  act(() => cbs.onEvent(thinkDelta(0, 'let me ')));
  act(() => cbs.onEvent(thinkDelta(0, 'think')));
  drainRaf();
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

test('tags an echoed user event with meta.source (coordinator vs explicit user vs untagged)', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] }, meta: { source: 'coordinator' } }));
  expect(result.current.items.find((i) => i.kind === 'user' && i.text === 'do the thing')?.source).toBe('coordinator');

  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'from a human' }] }, meta: { source: 'user' } }));
  expect(result.current.items.find((i) => i.kind === 'user' && i.text === 'from a human')?.source).toBe('user');

  // Untagged (older daemon / no meta) must stay undefined — render exactly like today.
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'untagged' }] } }));
  expect(result.current.items.find((i) => i.kind === 'user' && i.text === 'untagged')?.source).toBeUndefined();
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

test('a synthetic backfill result (completed revived thread) clears busy but appends no footer card', () => {
  // Mirrors backfillEventsFromTranscript's replay for a thread that finished before a
  // daemon restart: an assistant turn followed by the synthesized `subtype: 'backfill'`
  // result (Claude Code transcripts never write a real trailing result line).
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }));
  expect(result.current.busy).toBe(true);
  act(() => cbs.onEvent({ type: 'result', subtype: 'backfill', is_error: false }));
  expect(result.current.busy).toBe(false);
  expect(result.current.items.find((i) => i.kind === 'result')).toBeUndefined();
});

test('a backfilled INTERRUPTED thread (dangling tool_use, no synthetic result) stays busy', () => {
  // The server only synthesizes a backfill result for a completed tail — a thread that
  // was mid-turn when the daemon restarted (dangling tool_use, no trailing result) must
  // stay busy so kickstart-recovery, not this fix, is what resumes it.
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tu-1', input: { command: 'ls' } }] } }));
  expect(result.current.busy).toBe(true);
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

test('system/status toggles compacting and surfaces the result on the follow-up status', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  expect(result.current.compacting).toBe(false);
  expect(result.current.compactResult).toBeNull();

  act(() => cbs.onEvent({ type: 'system', subtype: 'status', status: 'compacting' }));
  expect(result.current.compacting).toBe(true);
  expect(result.current.compactResult).toBeNull();

  act(() => cbs.onEvent({ type: 'system', subtype: 'status', status: null, compact_result: 'success' }));
  expect(result.current.compacting).toBe(false);
  expect(result.current.compactResult).toEqual({ success: true, error: undefined });
});

test('system/status surfaces a failed compaction with its error', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'system', subtype: 'status', status: 'compacting' }));
  act(() => cbs.onEvent({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'boom' }));
  expect(result.current.compacting).toBe(false);
  expect(result.current.compactResult).toEqual({ success: false, error: 'boom' });
});

test('a new compacting status clears the previous result', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'system', subtype: 'status', status: 'compacting' }));
  act(() => cbs.onEvent({ type: 'system', subtype: 'status', status: null, compact_result: 'success' }));
  expect(result.current.compactResult).not.toBeNull();
  act(() => cbs.onEvent({ type: 'system', subtype: 'status', status: 'compacting' }));
  expect(result.current.compactResult).toBeNull();
});

test('compact() POSTs to the compact route', () => {
  const spy = vi.spyOn(api, 'compactTerminal').mockResolvedValue(undefined as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => { result.current.compact(); });
  expect(spy).toHaveBeenCalledWith('t1');
});

test('contextTokens is computed from the LATEST assistant event usage, not accumulated across turns', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  expect(result.current.contextTokens).toBeUndefined();

  act(() => cbs.onEvent({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'first' }], usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } },
  }));
  expect(result.current.contextTokens).toBe(160);

  // A second assistant event REPLACES the figure (reflects the latest call) rather
  // than summing across turns — unlike `result.usage`, which over-counts.
  act(() => cbs.onEvent({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'second' }], usage: { input_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }));
  expect(result.current.contextTokens).toBe(200);
});

test('contextTokens is NOT taken from the result event usage (would over-count a multi-tool turn)', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }));
  act(() => cbs.onEvent({ type: 'result', is_error: false, num_turns: 3, duration_ms: 10, usage: { input_tokens: 9999, output_tokens: 1 } }));
  expect(result.current.contextTokens).toBe(100);
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

// Drains every pending microtask (loadOlder chains .then().catch().finally(), so a single
// `await Promise.resolve()` isn't enough to observe the settled state).
async function flushAsync() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

test('loadOlder starts optimistic (hasMore=true, loadingOlder=false) before any fetch', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  expect(result.current.hasMore).toBe(true);
  expect(result.current.loadingOlder).toBe(false);
});

test('loadOlder fetches the tail window (no `before`) on the first call, prepends items, and applies hasMore', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({
    items: [{ kind: 'user', text: 'older msg', uuid: 'u1', line: 5 }],
    cursor: 50, startLine: 5, hasMore: true,
  } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => { result.current.loadOlder(); });
  expect(result.current.loadingOlder).toBe(true);
  await flushAsync();
  expect(spy).toHaveBeenCalledWith('t1', { before: undefined, limit: 120 });
  expect(result.current.loadingOlder).toBe(false);
  expect(result.current.hasMore).toBe(true);
  expect(result.current.items[0]).toMatchObject({ kind: 'user', text: 'older msg' });
});

test('a second loadOlder call anchors `before` on the previous response\'s startLine', async () => {
  const spy = vi.spyOn(api, 'getConversation')
    .mockResolvedValueOnce({ items: [{ kind: 'user', text: 'page1', uuid: 'p1', line: 40 }], cursor: 50, startLine: 40, hasMore: true } as any)
    .mockResolvedValueOnce({ items: [{ kind: 'user', text: 'page2', uuid: 'p2', line: 20 }], cursor: 50, startLine: 20, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(spy).toHaveBeenNthCalledWith(1, 't1', { before: undefined, limit: 120 });
  expect(spy).toHaveBeenNthCalledWith(2, 't1', { before: 40, limit: 120 });
  expect(result.current.hasMore).toBe(false);
  // Prepended oldest-first: page2 (older) ends up above page1 (newer).
  expect(result.current.items.map((i) => i.text)).toEqual(['page2', 'page1']);
});

test('loadOlder is a no-op while a fetch is already in flight (no concurrent duplicate request)', async () => {
  let resolveFetch!: (v: unknown) => void;
  const spy = vi.spyOn(api, 'getConversation').mockReturnValue(new Promise((r) => { resolveFetch = r; }) as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => { result.current.loadOlder(); });
  act(() => { result.current.loadOlder(); }); // fires while the first is still pending
  expect(spy).toHaveBeenCalledTimes(1);
  resolveFetch({ items: [], cursor: 0, startLine: 0, hasMore: false });
  await flushAsync();
});

test('loadOlder is a no-op once hasMore is false', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(result.current.hasMore).toBe(false);
  act(() => { result.current.loadOlder(); }); // hasMore is now false — must not re-fetch
  expect(spy).toHaveBeenCalledTimes(1);
});

test('switching terminalId re-arms pagination and discards a stale in-flight older-page fetch', async () => {
  let resolveFetch!: (v: unknown) => void;
  vi.spyOn(api, 'getConversation').mockReturnValue(new Promise((r) => { resolveFetch = r; }) as any);
  const { result, rerender } = renderHook(({ id }) => useStructuredChat(id), { initialProps: { id: 't1' } });
  act(() => { result.current.loadOlder(); });
  expect(result.current.loadingOlder).toBe(true);

  rerender({ id: 't2' }); // switch threads before the t1 fetch resolves
  expect(result.current.hasMore).toBe(true); // re-armed optimistic for the new thread
  expect(result.current.loadingOlder).toBe(false);

  // The stale t1 response lands late — it must NOT be applied to t2's state.
  resolveFetch({ items: [{ kind: 'user', text: 'stale t1 page', uuid: 'stale', line: 0 }], cursor: 10, startLine: 0, hasMore: false });
  await flushAsync();
  expect(result.current.items.some((i) => i.text === 'stale t1 page')).toBe(false);
  expect(result.current.loadingOlder).toBe(false);
});

test('a reconnect reset (onReset) re-arms pagination so a later loadOlder re-probes from the fresh tail', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(result.current.hasMore).toBe(false); // exhausted before the reconnect

  act(() => cbs.onReset?.());
  expect(result.current.hasMore).toBe(true); // re-armed — a fresh replay may have new older content
  expect(result.current.loadingOlder).toBe(false);

  act(() => { result.current.loadOlder(); });
  await flushAsync();
  // The post-reset fetch re-probes the tail (no `before`), not the exhausted anchor.
  expect(spy).toHaveBeenLastCalledWith('t1', { before: undefined, limit: 120 });
});

test('loadOlder dedups a page that overlaps content already rendered from the ws replay (no visible duplicate)', async () => {
  // The live ws tail already rendered this turn — it carries no uuid/line (the live
  // protocol has neither; see convItemFingerprint's doc comment).
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'recent turn' }] } }));
  expect(result.current.items.map((i) => i.text)).toEqual(['recent turn']);

  // The first loadOlder() call's REST window (before: undefined = newest) overlaps it.
  vi.spyOn(api, 'getConversation').mockResolvedValue({
    items: [
      { kind: 'user', text: 'genuinely older', uuid: 'u1', ts: '2024-01-01T00:00:00Z', line: 3 },
      { kind: 'assistant', text: 'recent turn', uuid: 'u2', ts: '2024-01-01T00:00:01Z', line: 4 },
    ],
    cursor: 50, startLine: 3, hasMore: true,
  } as any);
  act(() => { result.current.loadOlder(); });
  await flushAsync();

  // Only the genuinely-new item is prepended; the duplicate is dropped, not shown twice.
  expect(result.current.items.map((i) => i.text)).toEqual(['genuinely older', 'recent turn']);
});

test('loadOlder still advances the anchor/hasMore when an ENTIRE page duplicates existing items (no stall)', async () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'dup' }] } }));

  const spy = vi.spyOn(api, 'getConversation').mockResolvedValueOnce({
    items: [{ kind: 'assistant', text: 'dup', uuid: 'u1', ts: 't', line: 1 }],
    cursor: 50, startLine: 1, hasMore: true,
  } as any);
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  // No visible duplicate was appended…
  expect(result.current.items).toHaveLength(1);
  expect(result.current.hasMore).toBe(true);

  // …but the anchor moved past the duplicate page, so the NEXT call reaches strictly-older
  // content instead of re-fetching the same exhausted window forever.
  spy.mockResolvedValueOnce({ items: [], cursor: 50, startLine: 1, hasMore: false } as any);
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(spy).toHaveBeenLastCalledWith('t1', { before: 1, limit: 120 });
  expect(result.current.hasMore).toBe(false);
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
