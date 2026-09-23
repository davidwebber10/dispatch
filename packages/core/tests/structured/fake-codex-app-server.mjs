// packages/core/tests/structured/fake-codex-app-server.mjs
// A stand-in for `codex app-server`: speaks newline-delimited JSON-RPC 2.0 over stdio and
// replays a scripted turn (streaming assistant deltas + an optional file-change approval
// ServerRequest), so the CodexStructuredSessionManager can be tested hermetically. The frame
// SHAPES mirror the real captured fixtures (src/structured/codex-frames.fixture.ts).
import readline from 'node:readline';
import fs from 'node:fs';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });

// Opt-in request/response log for tests that need to inspect exact JSON-RPC frames the manager
// sent (e.g. proving `thread/start` carries top-level `developerInstructions`, or that a denied
// approval's WIRE response is the decline envelope and not an accept) without adding any
// test-only seam to the manager itself.
const logPath = process.env.CODEX_FAKE_LOG;
const logRequest = (method, params) => {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({ method, params }) + '\n');
};
const logResponse = (method, result) => {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({ response: method, result }) + '\n');
};

const THREAD = 'thread-fake-1';
const TURN = 'turn-fake-1';
let serverReqId = 100; // server→client request ids live in the server's own id space
const pendingApprovalThreadIds = new Map(); // serverReqId → the threadId the approval request was sent against
// serverReqId → { method, itemType, itemId, command, changes } for the approval kind, so the
// generic response handler below can log the right method and complete the RIGHT item.
const pendingApprovalMeta = new Map();

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // A response to a ServerRequest WE sent (the approval decision) — echoes our id.
  if (msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
    // Echo back whichever threadId the approval request was sent against (its OWN
    // session.threadId, e.g. the resumeId after a thread/resume) rather than always the
    // hardcoded THREAD constant — a resumed session's notifications must route back to it,
    // same as every other notify() below.
    const tid = pendingApprovalThreadIds.get(msg.id) ?? THREAD;
    const meta = pendingApprovalMeta.get(msg.id);
    pendingApprovalThreadIds.delete(msg.id);
    pendingApprovalMeta.delete(msg.id);
    logResponse(meta?.method ?? 'unknown', msg.result);
    switch (meta?.itemType) {
      case 'commandExecution':
        // The command-execution approval was answered (accept OR decline) → complete the item
        // (a real declined command wouldn't actually run, but the fake doesn't need to model
        // that — tests only assert on the manager's OWN response/event, not this echo) + turn.
        notify('item/completed', { threadId: tid, turnId: TURN, item: { type: 'commandExecution', id: meta.itemId, command: meta.command, cwd: '/tmp', aggregatedOutput: 'ok\n', status: 'completed' }, completedAtMs: 4 });
        break;
      case 'permissions':
        // A permissions/sandbox escalation isn't backed by a completable tool item — nothing
        // to finish here besides the turn.
        break;
      default:
        // The file-change approval was answered → finish the tool.
        notify('item/completed', { threadId: tid, turnId: TURN, item: { type: 'fileChange', id: meta?.itemId ?? 'fc-1', changes: meta?.changes ?? [{ path: '/tmp/hello.txt', kind: { type: 'add' }, diff: 'hi\n' }], status: 'completed' }, completedAtMs: 4 });
    }
    notify('turn/completed', { threadId: tid, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'completed', durationMs: 42 } });
    return;
  }

  if (msg.method === 'initialize') { respond(msg.id, { userAgent: 'fake', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: 'macos' }); return; }
  if (msg.method === 'initialized') { return; }

  if (msg.method === 'thread/start') {
    logRequest('thread/start', msg.params);
    respond(msg.id, { thread: { id: THREAD, turns: [] }, model: msg.params?.model ?? 'gpt-5.6-sol' });
    notify('thread/started', { thread: { id: THREAD, sessionId: THREAD, turns: [] } });
    return;
  }

  if (msg.method === 'thread/resume') {
    logRequest('thread/resume', msg.params);
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
    if (/no agent message/i.test(text)) {
      // A turn that ends with NO completed agentMessage at all (a failed turn, an interrupt
      // before any prose, a tool-only turn) — turn/completed still fires, but the translator
      // never sees an item/completed to stash text from. Tests the presence-not-truthiness
      // outcome-summary fix (Fix 2): the turn must persist an EMPTY summary, not fall back to
      // stale text from an earlier backfilled session.
      notify('turn/completed', { threadId: tid, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'completed', durationMs: 3 } });
      return;
    }
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

    const execMatch = text.match(/^exec (.+)$/i);
    const askMatch = /^ask /i.test(text);
    const escalateMatch = /^escalate/i.test(text);
    // `patch <path1>,<path2>,...` — a fileChange approval whose changes touch exactly the given
    // paths (Fix 3: multi-file ApplyPatch policy tests need deterministic, caller-chosen paths,
    // unlike the single hardcoded /tmp/hello.txt the plain `approve` trigger below sends).
    const patchMatch = text.match(/^patch (.+)$/i);
    // `patchmove <src>><dest>` — a fileChange whose change is a rename/move: the source `path`
    // plus a `kind.move_path` destination. Exercises the M2 containment path (a move whose
    // DESTINATION escapes the memory dir must be denied even when the source is inside it).
    const patchMoveMatch = text.match(/^patchmove (.+?)>(.+)$/i);
    if (execMatch) {
      // A shell command that requires approval (Task 5 policy tests): item/started carries the
      // command, then the ServerRequest fires and we WAIT for the client's decision (accept,
      // decline, OR a policy deny answered without any human involvement at all).
      const command = execMatch[1];
      notify('item/started', { threadId: tid, turnId: TURN, item: { type: 'commandExecution', id: 'cmd-1', command, cwd: '/tmp', status: 'inProgress' }, startedAtMs: 3 });
      const reqId = serverReqId++;
      pendingApprovalThreadIds.set(reqId, tid);
      pendingApprovalMeta.set(reqId, { method: 'item/commandExecution/requestApproval', itemType: 'commandExecution', itemId: 'cmd-1', command });
      send({ jsonrpc: '2.0', id: reqId, method: 'item/commandExecution/requestApproval', params: { threadId: tid, turnId: TURN, itemId: 'cmd-1', command, cwd: '/tmp', startedAtMs: 3, reason: null } });
    } else if (askMatch) {
      // The AskUserQuestion analogue (Task 5's alwaysSurface exemption test): fires the
      // ServerRequest and never resolves it itself — the test only asserts it SURFACED.
      const reqId = serverReqId++;
      pendingApprovalThreadIds.set(reqId, tid);
      pendingApprovalMeta.set(reqId, { method: 'item/tool/requestUserInput', itemType: 'askUserInput' });
      send({ jsonrpc: '2.0', id: reqId, method: 'item/tool/requestUserInput', params: { threadId: tid, turnId: TURN, questions: [{ id: 'q1', header: 'Choice', question: 'Pick one', options: ['A', 'B'] }] } });
    } else if (escalateMatch) {
      // A permissions/sandbox escalation request (Fix 1 test): the coordinator self-escalation
      // guard must decline this outright for a governed thread, with no item lifecycle needed.
      const reqId = serverReqId++;
      pendingApprovalThreadIds.set(reqId, tid);
      pendingApprovalMeta.set(reqId, { method: 'item/permissions/requestApproval', itemType: 'permissions', itemId: 'perm-1' });
      send({ jsonrpc: '2.0', id: reqId, method: 'item/permissions/requestApproval', params: { threadId: tid, turnId: TURN, itemId: 'perm-1', permissions: { network: true, sandbox: 'danger-full-access' }, cwd: '/tmp', reason: null } });
    } else if (patchMoveMatch) {
      const src = patchMoveMatch[1].trim();
      const dest = patchMoveMatch[2].trim();
      const changes = [{ path: src, kind: { type: 'update', move_path: dest }, diff: 'diff-0\n' }];
      notify('item/started', { threadId: tid, turnId: TURN, item: { type: 'fileChange', id: 'fc-2', changes, status: 'inProgress' }, startedAtMs: 3 });
      const reqId = serverReqId++;
      pendingApprovalThreadIds.set(reqId, tid);
      pendingApprovalMeta.set(reqId, { method: 'item/fileChange/requestApproval', itemType: 'fileChange', itemId: 'fc-2', changes });
      send({ jsonrpc: '2.0', id: reqId, method: 'item/fileChange/requestApproval', params: { threadId: tid, turnId: TURN, itemId: 'fc-2', startedAtMs: 3, reason: null, grantRoot: null } });
    } else if (patchMatch) {
      const paths = patchMatch[1].split(',').map((p) => p.trim()).filter(Boolean);
      const changes = paths.map((p, i) => ({ path: p, kind: { type: 'update' }, diff: `diff-${i}\n` }));
      notify('item/started', { threadId: tid, turnId: TURN, item: { type: 'fileChange', id: 'fc-2', changes, status: 'inProgress' }, startedAtMs: 3 });
      const reqId = serverReqId++;
      pendingApprovalThreadIds.set(reqId, tid);
      pendingApprovalMeta.set(reqId, { method: 'item/fileChange/requestApproval', itemType: 'fileChange', itemId: 'fc-2', changes });
      send({ jsonrpc: '2.0', id: reqId, method: 'item/fileChange/requestApproval', params: { threadId: tid, turnId: TURN, itemId: 'fc-2', startedAtMs: 3, reason: null, grantRoot: null } });
    } else if (/approve/i.test(text)) {
      // A file-change that requires approval: item/started carries the diff (approval params
      // omit it), then the ServerRequest fires and we WAIT for the client's decision.
      const changes = [{ path: '/tmp/hello.txt', kind: { type: 'add' }, diff: 'hi\n' }];
      notify('item/started', { threadId: tid, turnId: TURN, item: { type: 'fileChange', id: 'fc-1', changes, status: 'inProgress' }, startedAtMs: 3 });
      const reqId = serverReqId++;
      pendingApprovalThreadIds.set(reqId, tid);
      pendingApprovalMeta.set(reqId, { method: 'item/fileChange/requestApproval', itemType: 'fileChange', itemId: 'fc-1', changes });
      send({ jsonrpc: '2.0', id: reqId, method: 'item/fileChange/requestApproval', params: { threadId: tid, turnId: TURN, itemId: 'fc-1', startedAtMs: 3, reason: null, grantRoot: null } });
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
