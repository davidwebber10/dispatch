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

// ---- Injected context (loaded Skill content / system reminders) -------------------------
// When the model invokes a Skill, Claude Code injects the loaded SKILL.md into the
// conversation as a user-role TEXT message. The live stream-json marks it `isSynthetic:true`
// (the on-disk transcript marks the equivalent `isMeta` — see conversation/transcript.ts's
// `if (o.isMeta) return []`). It is NOT the human's turn and must not render as a "You"
// bubble. The daemon's own user-echo (manager.ts) carries neither flag, so real turns are
// unaffected. (The Skill tool card + its real tool_result still render — see below.)

test('skips an isSynthetic user text event (injected Skill content) — no user bubble', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'user', isSynthetic: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x\n\n# Skill' }] } }));
  expect(result.current.items.filter((i) => i.kind === 'user')).toHaveLength(0);
});

test('skips an isMeta user text event (transcript-shaped injected context) — no user bubble', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x\n\n# Skill' }] } }));
  expect(result.current.items.filter((i) => i.kind === 'user')).toHaveLength(0);
});

test('a normal user text event (neither flag) still renders exactly one user bubble', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a real human turn' }] } }));
  const users = result.current.items.filter((i) => i.kind === 'user');
  expect(users).toHaveLength(1);
  expect(users[0].text).toBe('a real human turn');
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

test('loadOlder anchors its first call on the oldest real-uuid item (beforeUuid) and prepends the older page', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({
    items: [{ kind: 'user', text: 'older msg', uuid: 'u1', line: 5 }],
    cursor: 50, startLine: 5, hasMore: true,
  } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  // The ws replay settles a real-uuid item first — the anchor for the first older-page fetch.
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'anchor', message: { content: [{ type: 'text', text: 'newest' }] } }));
  act(() => { result.current.loadOlder(); });
  expect(result.current.loadingOlder).toBe(true);
  await flushAsync();
  expect(spy).toHaveBeenCalledWith('t1', { before: undefined, beforeUuid: 'anchor', limit: 120 });
  expect(result.current.loadingOlder).toBe(false);
  expect(result.current.hasMore).toBe(true);
  expect(result.current.items[0]).toMatchObject({ kind: 'user', text: 'older msg' });
});

test('a second loadOlder call anchors `before` on the previous response\'s startLine', async () => {
  const spy = vi.spyOn(api, 'getConversation')
    .mockResolvedValueOnce({ items: [{ kind: 'user', text: 'page1', uuid: 'p1', line: 40 }], cursor: 50, startLine: 40, hasMore: true } as any)
    .mockResolvedValueOnce({ items: [{ kind: 'user', text: 'page2', uuid: 'p2', line: 20 }], cursor: 50, startLine: 20, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'anchor', message: { content: [{ type: 'text', text: 'newest' }] } }));
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(spy).toHaveBeenNthCalledWith(1, 't1', { before: undefined, beforeUuid: 'anchor', limit: 120 });
  expect(spy).toHaveBeenNthCalledWith(2, 't1', { before: 40, limit: 120 });
  expect(result.current.hasMore).toBe(false);
  // Prepended oldest-first: page2 (older) above page1 (newer) above the ws-settled anchor.
  expect(result.current.items.map((i) => i.text)).toEqual(['page2', 'page1', 'newest']);
});

test('loadOlder is a no-op while a fetch is already in flight (no concurrent duplicate request)', async () => {
  let resolveFetch!: (v: unknown) => void;
  const spy = vi.spyOn(api, 'getConversation').mockReturnValue(new Promise((r) => { resolveFetch = r; }) as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'anchor', message: { content: [{ type: 'text', text: 'newest' }] } }));
  act(() => { result.current.loadOlder(); });
  act(() => { result.current.loadOlder(); }); // fires while the first is still pending
  expect(spy).toHaveBeenCalledTimes(1);
  resolveFetch({ items: [], cursor: 0, startLine: 0, hasMore: false });
  await flushAsync();
});

test('loadOlder is a no-op once hasMore is false', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'anchor', message: { content: [{ type: 'text', text: 'newest' }] } }));
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
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'anchor', message: { content: [{ type: 'text', text: 'newest' }] } }));
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
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'anchor1', message: { content: [{ type: 'text', text: 'n1' }] } }));
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(result.current.hasMore).toBe(false); // exhausted before the reconnect

  act(() => cbs.onReset?.());
  expect(result.current.hasMore).toBe(true); // re-armed — a fresh replay may have new older content
  expect(result.current.loadingOlder).toBe(false);

  // onReset cleared items; the fresh replay settles a NEW anchor before older-paging resumes.
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'anchor2', message: { content: [{ type: 'text', text: 'n2' }] } }));
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  // The post-reset fetch re-probes the tail (no numeric `before`), anchored on the fresh uuid.
  expect(spy).toHaveBeenLastCalledWith('t1', { before: undefined, beforeUuid: 'anchor2', limit: 120 });
});

test('loadOlder dedups a page whose boundary item overlaps content already rendered from the ws replay (no visible duplicate)', async () => {
  // The ws replay already rendered this turn with its real transcript uuid (also the anchor).
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'u2', message: { content: [{ type: 'text', text: 'recent turn' }] } }));
  expect(result.current.items.map((i) => i.text)).toEqual(['recent turn']);

  // The older-page fetch returns a genuinely-older item PLUS a boundary item that re-includes
  // what's already rendered (same uuid u2) — the dup must be dropped, not prepended twice.
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
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'dup' }] } }));

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

// ---- BUG 1 (archived agent shows an empty chat) -----------------------------------------
// ws/structured.ts sends `{ type: 'system', subtype: 'inactive' }` before replay when no
// live process backs the thread (see service.ts's ensureStructuredAlive, which correctly
// never revives an archived terminal). The ws replay then has nothing to send — without a
// fallback, `items` stays `[]` forever and the view is stuck on EmptyState even though the
// full conversation exists on disk.

test("BUG 1 regression: a 'system'/'inactive' signal hydrates the initial view from the REST transcript instead of staying empty", async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({
    items: [
      { kind: 'user', text: 'from disk', uuid: 'u1', line: 10 },
      { kind: 'assistant', text: 'reply', uuid: 'u2', line: 11 },
    ],
    cursor: 50, startLine: 10, hasMore: true,
  } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  expect(result.current.items).toHaveLength(0);
  act(() => cbs.onEvent({ type: 'system', subtype: 'inactive' }));
  expect(result.current.loadingOlder).toBe(true);
  await flushAsync();
  expect(spy).toHaveBeenCalledWith('t1', { limit: 120 });
  expect(result.current.items.map((i) => i.text)).toEqual(['from disk', 'reply']);
  expect(result.current.hasMore).toBe(true);
  expect(result.current.loadingOlder).toBe(false);
});

test('the inactive hydration only fires once (no duplicate fetch from a second signal)', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
  renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'system', subtype: 'inactive' }));
  act(() => cbs.onEvent({ type: 'system', subtype: 'inactive' }));
  await flushAsync();
  expect(spy).toHaveBeenCalledTimes(1);
});

test('the inactive hydration does not clobber items a live event already populated first', async () => {
  let resolveFetch!: (v: unknown) => void;
  vi.spyOn(api, 'getConversation').mockReturnValue(new Promise((r) => { resolveFetch = r; }) as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'system', subtype: 'inactive' }));
  // A live event lands before the REST fetch resolves (e.g. the thread was revived
  // elsewhere right as this signal was in flight) — it must win over a stale REST page.
  act(() => cbs.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'live wins' }] } }));
  resolveFetch({ items: [{ kind: 'user', text: 'stale disk read', uuid: 'u1', line: 0 }], cursor: 5, startLine: 0, hasMore: false });
  await flushAsync();
  expect(result.current.items.map((i) => i.text)).toEqual(['live wins']);
});

test('the inactive hydration still applies when only a stale result FOOTER rendered (deadlock ring), keeping the footer below the history', async () => {
  vi.spyOn(api, 'getConversation').mockResolvedValue({
    items: [
      { kind: 'user', text: 'from disk', uuid: 'u1', line: 10 },
      { kind: 'assistant', text: 'reply', uuid: 'u2', line: 11 },
    ],
    cursor: 50, startLine: 10, hasMore: false,
  } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'system', subtype: 'inactive' }));
  // The deadlock ring replays a stale (non-backfill) result AFTER the sentinel — the
  // footer item this appends must not defeat the hydration.
  act(() => cbs.onEvent({ type: 'result', is_error: false, duration_ms: 5 }));
  await flushAsync();
  expect(result.current.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'result']);
  expect(result.current.items.map((i) => i.text ?? '')).toEqual(['from disk', 'reply', '']);
});

test('a discarded inactive page leaves the paging anchor UNSET so later paging cannot skip its window', async () => {
  const spy = vi.spyOn(api, 'getConversation')
    .mockResolvedValueOnce({ items: [{ kind: 'user', text: 'newest disk window', uuid: 'w1', line: 30 }], cursor: 50, startLine: 30, hasMore: true } as any)
    .mockResolvedValueOnce({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'system', subtype: 'inactive' }));
  // A live turn lands before the rescue fetch resolves — the page is discarded.
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'live1', message: { content: [{ type: 'text', text: 'live wins' }] } }));
  await flushAsync();
  expect(result.current.items.map((i) => i.text)).toEqual(['live wins']);
  // The next loadOlder must anchor on the live item's uuid — NOT on the discarded page's
  // startLine, which would silently skip everything in that dropped window.
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(spy).toHaveBeenLastCalledWith('t1', { before: undefined, beforeUuid: 'live1', limit: 120 });
});

test('RACE: a live conversational event lands in the SAME microtask window as the rescue fetch resolving (itemsRef not yet re-synced) — hasMore is not latched false by the discarded page, and the anchor stays unset', async () => {
  let resolveFetch!: (v: unknown) => void;
  const spy = vi.spyOn(api, 'getConversation').mockReturnValue(new Promise((r) => { resolveFetch = r; }) as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'system', subtype: 'inactive' }));
  // Both the live event AND the fetch resolution happen inside ONE act(async...) callback,
  // with no intervening `await act(...)` boundary — the narrowest window we can force in a
  // test environment for the itemsRef passive-effect sync to lag behind. The rescue page
  // below carries hasMore:false and a startLine far from the live item, so either bug
  // symptom (a latched-false hasMore, or an anchor pointing at the discarded page) would be
  // caught by the assertions after.
  await act(async () => {
    cbs.onEvent({ type: 'assistant', uuid: 'live1', message: { content: [{ type: 'text', text: 'live wins' }] } });
    resolveFetch({ items: [{ kind: 'user', text: 'stale disk read', uuid: 'w1', line: 30 }], cursor: 50, startLine: 30, hasMore: false });
    await Promise.resolve();
    await Promise.resolve();
  });
  // The live item is the only thing rendered — the rescue page must have been discarded.
  expect(result.current.items.map((i) => i.text)).toEqual(['live wins']);
  // Must NOT be latched false by the discarded page's hasMore:false (the bug this guards).
  expect(result.current.hasMore).toBe(true);
  // The next loadOlder must anchor on the live item's uuid — NOT `before: 30` (the
  // discarded page's startLine), which would silently skip everything in that window.
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(spy).toHaveBeenLastCalledWith('t1', { before: undefined, beforeUuid: 'live1', limit: 120 });
});

// ---- BUG 2 (tool rows render above the prompt that kicked off the agent) ----------------
// Root fix: the ws fold and the REST/transcript parser now share Claude Code's own
// per-message-block `uuid` (threaded onto ConvItems in the 'assistant'/'user' handlers
// above), so loadOlder's dedup can match real identity instead of a lossy content
// fingerprint that a tool item's asymmetric shape (toolId presence, toolInput formatting)
// defeats.

test('BUG 2 regression: loadOlder dedups a tool item via shared uuid identity even though its toolId/toolInput formatting differs between ws and REST', async () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  // ws already rendered a prompt, then a tool call — the RICH ws shape (real toolId,
  // pretty-JSON toolInput from the whole-assistant-event reconcile).
  act(() => cbs.onEvent({ type: 'user', uuid: 'u-prompt', message: { role: 'user', content: [{ type: 'text', text: 'run ls' }] } }));
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'u-tool', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tu-1', input: { command: 'ls -la' } }] } }));
  expect(result.current.items.map((i) => i.kind)).toEqual(['user', 'tool']);

  // The first loadOlder() call's REST window overlaps: the SAME two turns, but shaped like
  // conversation/transcript.ts's parser — no toolId at all, and Bash's toolInput is the bare
  // command string (transcript.ts's toolInputString), not pretty JSON. A content fingerprint
  // (kind+toolId+toolName+text+toolInput) would NOT match this pair — that mismatch was the
  // actual bug (the "fresh" REST tool row got prepended ABOVE the already-deduped prompt).
  vi.spyOn(api, 'getConversation').mockResolvedValue({
    items: [
      { kind: 'user', text: 'run ls', uuid: 'u-prompt', line: 4 },
      { kind: 'tool', toolName: 'Bash', toolInput: 'ls -la', uuid: 'u-tool', line: 5 },
    ],
    cursor: 10, startLine: 4, hasMore: false,
  } as any);
  act(() => { result.current.loadOlder(); });
  await flushAsync();

  // No duplicate tool row above the prompt — order is exactly as originally ws-rendered,
  // and the richer ws-side tool item (real toolId) is what's kept, not overwritten.
  expect(result.current.items.map((i) => i.kind)).toEqual(['user', 'tool']);
  expect(result.current.items.find((i) => i.kind === 'tool')?.toolId).toBe('tu-1');
});

test('streaming mode: the whole-assistant reconcile event upgrades a text item\'s synthetic block key to the real transcript uuid', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'text' })));
  act(() => cbs.onEvent(textDelta(0, 'hello')));
  drainRaf();
  const before = result.current.items.find((i) => i.kind === 'assistant');
  expect(before?.uuid).toMatch(/^s-/); // synthetic per-block streaming key, before the reconcile lands

  act(() => cbs.onEvent({ type: 'assistant', uuid: 'real-uuid-1', message: { content: [{ type: 'text', text: 'hello' }] } }));
  const after = result.current.items.find((i) => i.kind === 'assistant');
  expect(after?.uuid).toBe('real-uuid-1'); // upgraded to the real identity
  expect(after?.text).toBe('hello'); // content itself untouched by the upgrade
});

test('streaming mode: a reconciled tool item gets its synthetic key upgraded to the real uuid alongside the toolInput reconcile', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'tool_use', name: 'Read', id: 'tu-1' })));
  act(() => cbs.onEvent(jsonDelta(0, '{"file_path":"/a.ts"}')));
  flushRaf();
  const before = result.current.items.find((i) => i.kind === 'tool');
  expect(before?.uuid).toMatch(/^s-/);

  act(() => cbs.onEvent({ type: 'assistant', uuid: 'real-uuid-2', message: { content: [{ type: 'tool_use', name: 'Read', id: 'tu-1', input: { file_path: '/a.ts' } }] } }));
  const after = result.current.items.find((i) => i.kind === 'tool');
  expect(after?.uuid).toBe('real-uuid-2');
  expect(after?.toolInput).toContain('/a.ts'); // the pre-existing toolInput reconcile still happens too
  expect(result.current.items.filter((i) => i.kind === 'tool')).toHaveLength(1); // no duplicate appended
});

test("loadOlder's first call anchors on the oldest rendered item's uuid (beforeUuid), not just before:undefined", async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'u-oldest', message: { content: [{ type: 'text', text: 'oldest rendered' }] } }));
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(spy).toHaveBeenCalledWith('t1', { before: undefined, beforeUuid: 'u-oldest', limit: 120 });
});

// ---- Transcript-duplication regression (anchorless loadOlder racing the ws replay) -------
// BootstrapOlderPages fires loadOlder() on mount. If it fires before the ws replay has
// settled a real transcript uuid onto `items`, loadOlder sends an ANCHORLESS fetch
// (before/beforeUuid both undefined), which the server answers with the NEWEST window (the
// whole transcript). The ws onEvent handlers would then re-append the same turns, so the
// conversation rendered twice. The guard below suppresses that fetch whenever items EXIST
// but carry no real anchor; the zero-items case is instead made safe by uuid-dedup on the
// ws append paths (see the deadlock tests further down).

// ---- Zero-items history DEADLOCK (the "reopening a Pretty thread shows no history" bug) --
// A replay ring holding only NON-RENDERING events (system/init, system/status, a stale
// result) is non-empty, so ws/structured.ts never sends the `system/inactive` REST-hydration
// rescue — yet ChatView renders zero items. The old guard also bailed on zero items, and did
// so SYNCHRONOUSLY without touching `loadingOlder`, so useBootstrapOlderPages' effect never
// re-fired and there was nothing on screen to scroll. History was permanently unreachable.

test('with ZERO items rendered, loadOlder does NOT fetch — the newest window is owned by the ws replay / server inactive rescue', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  expect(result.current.items).toHaveLength(0);
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(spy).not.toHaveBeenCalled(); // an anchorless fetch returns the NEWEST window and races the replay
  expect(result.current.loadingOlder).toBe(false);
});

test('GUARD PRESERVED: with items rendered but no real uuid among them, loadOlder still bails (no anchorless fetch)', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  // An item exists, but its only identity is the synthetic streaming key — not resolvable
  // on disk as a beforeUuid, so an anchorless newest-window fetch could double-render.
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'text' })));
  act(() => cbs.onEvent(textDelta(0, 'partial')));
  drainRaf();
  expect(result.current.items).toHaveLength(1);
  expect(result.current.items[0].uuid).toMatch(/^s-/);
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(spy).not.toHaveBeenCalled();
  expect(result.current.loadingOlder).toBe(false);
});

test('a synthetic streaming key does NOT count as an anchor (still no anchorless fetch mid-stream)', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({ items: [], cursor: 0, startLine: 0, hasMore: false } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  // A block is streaming — its item carries only the synthetic `s-<turn>-<idx>` key, which the
  // server can't resolve as a beforeUuid. loadOlder must treat that as "no anchor yet".
  act(() => cbs.onEvent({ type: 'stream_event', event: { type: 'message_start' } }));
  act(() => cbs.onEvent(start(0, { type: 'text' })));
  act(() => cbs.onEvent(textDelta(0, 'partial')));
  drainRaf();
  expect(result.current.items.find((i) => i.kind === 'assistant')?.uuid).toMatch(/^s-/);
  act(() => { result.current.loadOlder(); });
  await flushAsync();
  expect(spy).not.toHaveBeenCalled();
});

test('REGRESSION: a mount-time loadOlder racing the ws replay does not double the transcript (no anchorless fetch is ever issued)', async () => {
  const spy = vi.spyOn(api, 'getConversation').mockResolvedValue({
    items: [
      { kind: 'user', text: 'q', uuid: 'u1', line: 0 },
      { kind: 'assistant', text: 'a', uuid: 'u2', line: 1 },
    ],
    cursor: 2, startLine: 0, hasMore: false,
  } as any);
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => { result.current.loadOlder(); }); // bootstrap fires on mount, items still empty
  await flushAsync();
  expect(spy).not.toHaveBeenCalled(); // the newest-window fetch that caused the doubling never happens
  // The ws replay lands the turns exactly once, in order.
  act(() => cbs.onEvent({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } }));
  act(() => cbs.onEvent({ type: 'assistant', uuid: 'u2', message: { content: [{ type: 'text', text: 'a' }] } }));
  expect(result.current.items.map((i) => i.text)).toEqual(['q', 'a']);
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

// ---- Background-task notifications ----------------------------------------------------
// Claude Code reports a finished background task by injecting a `role: 'user'` turn whose
// body is a <task-notification> XML block. Unlike the injected context above it carries
// NEITHER isSynthetic NOR isMeta — the only on-disk marker is `origin.kind`, which does not
// survive into the stream envelope — so the flag guards can't catch it and it used to render
// as the human's own green bubble full of raw XML. Classified by content shape instead.

const TASK_NOTIFICATION = `<task-notification>
<task-id>bdjq1tq9y</task-id>
<tool-use-id>toolu_018vsfoaz</tool-use-id>
<output-file>/private/tmp/claude-501/tasks/bdjq1tq9y.output</output-file>
<status>completed</status>
<summary>Background command "Wait for the deploy to finish" completed (exit code 0)</summary>
</task-notification>`;

test('demotes a task-notification text block to a notice, not a user bubble', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: TASK_NOTIFICATION }] } }));
  expect(result.current.items.filter((i) => i.kind === 'user')).toHaveLength(0);
  const notices = result.current.items.filter((i) => i.kind === 'notice');
  expect(notices).toHaveLength(1);
  // Only the readable summary survives — the bookkeeping XML is dropped.
  expect(notices[0].text).toBe('Background command "Wait for the deploy to finish" completed (exit code 0)');
});

test('demotes the string-content form too (transcript backfill after a daemon restart)', () => {
  // A turn rebuilt from the transcript stores `content` as a bare string, not an array —
  // the resume path, which is how most of these actually reach the client.
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: TASK_NOTIFICATION } }));
  expect(result.current.items.filter((i) => i.kind === 'user')).toHaveLength(0);
  expect(result.current.items.filter((i) => i.kind === 'notice')).toHaveLength(1);
});

test('a human turn that merely mentions the tag keeps its bubble', () => {
  const { result } = renderHook(() => useStructuredChat('t1'));
  act(() => cbs.onEvent({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'why is <task-notification> showing as a user chat?' }] } }));
  expect(result.current.items.filter((i) => i.kind === 'user')).toHaveLength(1);
  expect(result.current.items.filter((i) => i.kind === 'notice')).toHaveLength(0);
});
