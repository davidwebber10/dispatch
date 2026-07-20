// packages/core/tests/structured/fake-codex-app-server.mjs
// A stand-in for `codex app-server`: speaks newline-delimited JSON-RPC 2.0 over stdio and
// replays a scripted turn (streaming assistant deltas + an optional file-change approval
// ServerRequest), so the CodexStructuredSessionManager can be tested hermetically. The frame
// SHAPES mirror the real captured fixtures (src/structured/codex-frames.fixture.ts).
import readline from 'node:readline';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });

const THREAD = 'thread-fake-1';
const TURN = 'turn-fake-1';
let serverReqId = 100; // server→client request ids live in the server's own id space

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // A response to a ServerRequest WE sent (the approval decision) — echoes our id.
  if (msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
    // The file-change approval was answered → finish the tool + the turn.
    notify('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'fileChange', id: 'fc-1', changes: [{ path: '/tmp/hello.txt', kind: { type: 'add' }, diff: 'hi\n' }], status: 'completed' }, completedAtMs: 4 });
    notify('turn/completed', { threadId: THREAD, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'completed', durationMs: 42 } });
    return;
  }

  if (msg.method === 'initialize') { respond(msg.id, { userAgent: 'fake', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: 'macos' }); return; }
  if (msg.method === 'initialized') { return; }

  if (msg.method === 'thread/start') {
    respond(msg.id, { thread: { id: THREAD, turns: [] }, model: msg.params?.model ?? 'gpt-5.6-sol' });
    notify('thread/started', { thread: { id: THREAD, sessionId: THREAD, turns: [] } });
    return;
  }

  if (msg.method === 'thread/resume') {
    const tid = msg.params?.threadId ?? THREAD;
    // Return one prior completed turn so the backfill path has history to replay.
    respond(msg.id, { thread: { id: tid, turns: [{ id: 'prev', items: [
      { type: 'userMessage', id: 'u0', content: [{ type: 'text', text: 'earlier question' }] },
      { type: 'agentMessage', id: 'a0', text: 'earlier answer' },
    ], status: 'completed' }] }, model: 'gpt-5.6-sol' });
    notify('thread/started', { thread: { id: tid, sessionId: tid, turns: [] } });
    return;
  }

  if (msg.method === 'turn/start') {
    // Echo back whichever threadId the client requested against (its OWN session.threadId,
    // e.g. the resumeId after a thread/resume) rather than always the hardcoded THREAD
    // constant — a resumed session's live-turn notifications must route back to it, exactly
    // like the real app-server would.
    const tid = msg.params?.threadId ?? THREAD;
    respond(msg.id, { turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'inProgress' } });
    const text = (msg.params?.input ?? []).filter((i) => i.type === 'text').map((i) => i.text).join(' ');
    notify('turn/started', { threadId: tid, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'inProgress' } });
    // Stream an assistant message token-by-token. Default closing text is 'Hello world' (not a
    // question); a request containing "needs a decision" gets a closing question instead, so
    // tests can exercise the needs-help turn-end path end-to-end without a dedicated frame shape.
    const agentText = /needs a decision/i.test(text) ? 'Rewired the rail. Does that look right to you?' : 'Hello world';
    const mid = Math.ceil(agentText.length / 2);
    notify('item/started', { threadId: tid, turnId: TURN, item: { type: 'agentMessage', id: 'msg-1', text: '', phase: 'commentary', memoryCitation: null }, startedAtMs: 1 });
    notify('item/agentMessage/delta', { threadId: tid, turnId: TURN, itemId: 'msg-1', delta: agentText.slice(0, mid) });
    notify('item/agentMessage/delta', { threadId: tid, turnId: TURN, itemId: 'msg-1', delta: agentText.slice(mid) });
    notify('item/completed', { threadId: tid, turnId: TURN, item: { type: 'agentMessage', id: 'msg-1', text: agentText, phase: 'commentary', memoryCitation: null }, completedAtMs: 2 });
    notify('thread/tokenUsage/updated', { threadId: tid, turnId: TURN, tokenUsage: { total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 20, outputTokens: 20, reasoningOutputTokens: 0 }, last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 20, outputTokens: 20, reasoningOutputTokens: 0 }, modelContextWindow: 258400 } });

    if (/approve/i.test(text)) {
      // A file-change that requires approval: item/started carries the diff (approval params
      // omit it), then the ServerRequest fires and we WAIT for the client's decision.
      notify('item/started', { threadId: tid, turnId: TURN, item: { type: 'fileChange', id: 'fc-1', changes: [{ path: '/tmp/hello.txt', kind: { type: 'add' }, diff: 'hi\n' }], status: 'inProgress' }, startedAtMs: 3 });
      send({ jsonrpc: '2.0', id: serverReqId++, method: 'item/fileChange/requestApproval', params: { threadId: tid, turnId: TURN, itemId: 'fc-1', startedAtMs: 3, reason: null, grantRoot: null } });
    } else {
      notify('turn/completed', { threadId: tid, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'completed', durationMs: 42 } });
    }
    return;
  }

  if (msg.method === 'turn/interrupt') {
    const tid = msg.params?.threadId ?? THREAD;
    respond(msg.id, {});
    notify('turn/completed', { threadId: tid, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'interrupted', durationMs: 5 } });
    return;
  }

  if (msg.method === 'thread/compact/start') { respond(msg.id, {}); return; }
  // Unknown requests still need a response so the client's pending map drains.
  if (msg.id !== undefined && msg.method) respond(msg.id, {});
});
