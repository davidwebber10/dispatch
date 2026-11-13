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

// --- subagents (subagents-v1) ----------------------------------------------------------------
// `subagent <basic|approval|slow>` on a main turn: the main agent spawns ONE sub-thread (frame shapes
// from the codex-cli 0.167.2 generated types; the started item is the one recorded on 0.167.0),
// says one line and ends its turn; the sub-thread then runs its own turn:
//   basic    — streams a reply, runs one command, ends `completed`;
//   approval — asks an MCP tool approval (elicitation) on the SUB-thread, then ends on the answer;
//   slow     — starts its turn and waits (a turn/interrupt ends it `interrupted`).
// `replay-file <path>`: each line of the JSON-lines file is a notification `{method, params}`; the
// string `$MAIN` in it becomes the main thread id. A line `{"wait": <ms>}` pauses.
const SUB = 'sub-thread-1';
const SUB_TURN = 'turn-sub-1';
const AGENT_PATH = '/root/review_the_files';
function runSubagent(tid, mode) {
  const activity = (id, kind, extra = {}) => ({ type: 'subAgentActivity', id, kind, agentThreadId: SUB, agentPath: AGENT_PATH, model: 'gpt-fake-sub', reasoningEffort: 'medium', ...extra });
  notify('item/started', { threadId: tid, turnId: TURN, item: activity('call_sa_1', 'started', { startedAtMs: 1000, completedAtMs: null }) });
  notify('item/completed', { threadId: tid, turnId: TURN, item: activity('call_sa_1', 'started', { startedAtMs: 1000, completedAtMs: null }) });
  notify('thread/started', { thread: { id: SUB, sessionId: tid, parentThreadId: tid, source: { subagent: { thread_spawn: { parent_thread_id: tid, depth: 1, agent_path: AGENT_PATH, agent_nickname: null, agent_role: 'reviewer' } } }, agentNickname: null, agentRole: 'reviewer', model: 'gpt-fake-sub', reasoningEffort: 'medium', turns: [] } });
  notify('item/completed', { threadId: tid, turnId: TURN, item: { type: 'agentMessage', id: 'msg-main-sub', text: 'Started a subagent.', phase: 'final_answer', memoryCitation: null } });
  notify('turn/completed', { threadId: tid, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'completed', durationMs: 5 } });
  setTimeout(() => {
    notify('turn/started', { threadId: SUB, turn: { id: SUB_TURN, items: [], itemsView: 'notLoaded', status: 'inProgress' } });
    if (mode === 'slow') return;
    notify('item/started', { threadId: SUB, turnId: SUB_TURN, item: { type: 'agentMessage', id: 'msg-sub-1', text: '', phase: 'commentary', memoryCitation: null } });
    notify('item/agentMessage/delta', { threadId: SUB, turnId: SUB_TURN, itemId: 'msg-sub-1', delta: 'Reading the files.' });
    notify('item/completed', { threadId: SUB, turnId: SUB_TURN, item: { type: 'agentMessage', id: 'msg-sub-1', text: 'Reading the files.', phase: 'commentary', memoryCitation: null } });
    notify('item/started', { threadId: SUB, turnId: SUB_TURN, item: { type: 'commandExecution', id: 'cmd-sub-1', command: 'ls', cwd: '/tmp', status: 'inProgress' } });
    notify('item/completed', { threadId: SUB, turnId: SUB_TURN, item: { type: 'commandExecution', id: 'cmd-sub-1', command: 'ls', cwd: '/tmp', aggregatedOutput: 'a\nb\n', status: 'completed' } });
    notify('thread/tokenUsage/updated', { threadId: SUB, turnId: SUB_TURN, tokenUsage: { total: { totalTokens: 300, inputTokens: 250, cachedInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 }, last: { totalTokens: 300, inputTokens: 250, cachedInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 }, modelContextWindow: 258400 } });
    if (mode === 'approval') {
      notify('item/started', { threadId: SUB, turnId: SUB_TURN, item: { type: 'mcpToolCall', id: 'mcp-sub-1', server: 'company', tool: 'lookup', status: 'inProgress', arguments: { q: 1 } } });
      const reqId = serverReqId++;
      pendingApprovalThreadIds.set(reqId, SUB);
      pendingApprovalMeta.set(reqId, { method: 'mcpServer/elicitation/request', itemType: 'subMcp', itemId: 'mcp-sub-1', server: 'company', tool: 'lookup' });
      send({ jsonrpc: '2.0', id: reqId, method: 'mcpServer/elicitation/request', params: { threadId: SUB, turnId: SUB_TURN, serverName: 'company', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session'], tool_description: 'd', tool_params: { q: 1 }, tool_params_display: [] }, message: 'Allow the company MCP server to run tool "lookup"?', requestedSchema: { type: 'object', properties: {} } } });
      return;
    }
    endSubTurn('The files have two issues.');
  }, 30);
}
function endSubTurn(text) {
  notify('item/completed', { threadId: SUB, turnId: SUB_TURN, item: { type: 'agentMessage', id: 'msg-sub-2', text, phase: 'final_answer', memoryCitation: null } });
  notify('turn/completed', { threadId: SUB, turn: { id: SUB_TURN, items: [], itemsView: 'notLoaded', status: 'completed', durationMs: 40 } });
}
async function replayFile(tid, file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const f = JSON.parse(line.replaceAll('$MAIN', tid));
    if (f._note) continue;
    if (f.wait) { await new Promise((r) => setTimeout(r, f.wait)); continue; }
    notify(f.method, f.params);
  }
}

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
    logResponse(meta?.method ?? 'unknown', msg.result !== undefined ? msg.result : { error: msg.error });
    // A declined request completes its item the way the real app-server does: status 'declined'
    // and no output (a declined command never ran) — so tests see the same follow-up frame a
    // live coordinator gets after a policy deny.
    const declined = msg.result?.decision === 'decline';
    switch (meta?.itemType) {
      case 'subMcp': {
        // A sub-thread's MCP approval: the tool runs on accept, then the sub-thread ends its turn.
        const accepted = msg.result?.action === 'accept';
        notify('item/completed', { threadId: SUB, turnId: SUB_TURN, item: { type: 'mcpToolCall', id: meta.itemId, server: meta.server, tool: meta.tool, status: accepted ? 'completed' : 'failed', arguments: {}, result: accepted ? { content: [{ type: 'text', text: 'found' }] } : null, error: accepted ? null : { message: 'user rejected MCP tool call' } } });
        endSubTurn(accepted ? 'The lookup found it.' : 'The lookup was refused.');
        return;
      }
      case 'mcpToolCall': {
        // An MCP tool-call approval (elicitation) was answered → the tool runs only on accept.
        const accepted = msg.result?.action === 'accept';
        notify('item/completed', { threadId: tid, turnId: TURN, item: { type: 'mcpToolCall', id: meta.itemId, server: meta.server, tool: meta.tool, status: accepted ? 'completed' : 'failed', arguments: {}, result: accepted ? { content: [{ type: 'text', text: 'pong' }] } : null, error: accepted ? null : { message: 'user rejected MCP tool call' } }, completedAtMs: 4 });
        break;
      }
      case 'elicitation':
        break; // a real (non-tool) elicitation: nothing to complete besides the turn
      case 'commandExecution':
        // The command-execution approval was answered (accept OR decline) → complete the item + turn.
        notify('item/completed', { threadId: tid, turnId: TURN, item: { type: 'commandExecution', id: meta.itemId, command: meta.command, cwd: '/tmp', aggregatedOutput: declined ? null : 'ok\n', status: declined ? 'declined' : 'completed' }, completedAtMs: 4 });
        break;
      case 'permissions':
        // A permissions/sandbox escalation isn't backed by a completable tool item — nothing
        // to finish here besides the turn.
        break;
      default:
        // The file-change approval was answered → finish the tool.
        notify('item/completed', { threadId: tid, turnId: TURN, item: { type: 'fileChange', id: meta?.itemId ?? 'fc-1', changes: meta?.changes ?? [{ path: '/tmp/hello.txt', kind: { type: 'add' }, diff: 'hi\n' }], status: declined ? 'declined' : 'completed' }, completedAtMs: 4 });
    }
    notify('turn/completed', { threadId: tid, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'completed', durationMs: 42 } });
    return;
  }

  // CODEX_FAKE_INIT_HANG=1: an app-server that is alive but never answers `initialize` (round 3 test).
  if (msg.method === 'initialize' && process.env.CODEX_FAKE_INIT_HANG) return;
  if (msg.method === 'initialize') { respond(msg.id, { userAgent: 'fake', codexHome: '/tmp/.codex', platformFamily: 'unix', platformOs: 'macos' }); return; }
  if (msg.method === 'initialized') { return; }

  if (msg.method === 'thread/start') {
    logRequest('thread/start', msg.params);
    // CODEX_FAKE_START_HANG_ONCE=<marker file>: same as the resume variant below, for a fresh start.
    const startMarker = process.env.CODEX_FAKE_START_HANG_ONCE;
    if (startMarker && !fs.existsSync(startMarker)) { fs.writeFileSync(startMarker, '1'); return; }
    respond(msg.id, { thread: { id: THREAD, turns: [] }, model: msg.params?.model ?? 'gpt-5.6-sol' });
    notify('thread/started', { thread: { id: THREAD, sessionId: THREAD, turns: [] } });
    return;
  }

  if (msg.method === 'thread/resume') {
    logRequest('thread/resume', msg.params);
    // CODEX_FAKE_RESUME_HANG_ONCE=<marker file>: the first process to see a resume never answers
    // (the test then kills it mid-flight); a respawned process finds the marker and answers.
    const hangMarker = process.env.CODEX_FAKE_RESUME_HANG_ONCE;
    if (hangMarker && !fs.existsSync(hangMarker)) { fs.writeFileSync(hangMarker, '1'); return; }
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
    logRequest('turn/start', msg.params);
    // CODEX_FAKE_TURN_REJECT=effort|model|both: turn/start refuses a changed effort or model, like the real app-server does
    // for a level or a model it does not take (round 4 test).
    // CODEX_FAKE_EXIT_ON_TURN=1: the app-server dies on a turn/start (a transport failure, not a refusal).
    if (process.env.CODEX_FAKE_EXIT_ON_TURN) process.exit(1);
    // CODEX_FAKE_TURN_REJECT=generic: refuses a bad pick with a message that names neither the effort nor the model.
    if (process.env.CODEX_FAKE_TURN_REJECT === 'generic' && (msg.params?.effort === 'bad' || msg.params?.model === 'bad-model')) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'invalid params' } });
      return;
    }
    const rej = process.env.CODEX_FAKE_TURN_REJECT;
    if (rej && ((rej !== 'model' && msg.params?.effort === 'bad') || (rej !== 'effort' && msg.params?.model === 'bad-model'))) {
      const what = msg.params?.effort === 'bad' && rej !== 'model' ? 'unsupported reasoning effort: bad' : 'unknown model: bad-model';
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: what } });
      return;
    }
    respond(msg.id, { turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'inProgress' } });
    const text = (msg.params?.input ?? []).filter((i) => i.type === 'text').map((i) => i.text).join(' ');
    logRequest('turn/start:text', { threadId: tid, text });
    notify('turn/started', { threadId: tid, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'inProgress' } });
    // `hang` — a turn that starts and never ends: the thread stays `working` until it is killed
    // (a daemon shutdown mid-turn).
    if (/^hang$/i.test(text)) return;
    if (/no agent message/i.test(text)) {
      // A turn that ends with NO completed agentMessage at all (a failed turn, an interrupt
      // before any prose, a tool-only turn) — turn/completed still fires, but the translator
      // never sees an item/completed to stash text from. Tests the presence-not-truthiness
      // outcome-summary fix (Fix 2): the turn must persist an EMPTY summary, not fall back to
      // stale text from an earlier backfilled session.
      notify('turn/completed', { threadId: tid, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'completed', durationMs: 3 } });
      return;
    }
    // `report-file <path>` — an agent's report turn (decision cards): each string of the JSON
    // array in <path> is one agentMessage, streamed as deltas and then completed with its full
    // text, with a dispatch report_status mcpToolCall between two messages — the way a real
    // agent writes its report, calls report_status, and says a last short line.
    const subMatch = text.match(/^subagent (basic|approval|slow)$/i);
    if (subMatch) { runSubagent(tid, subMatch[1].toLowerCase()); return; }
    const replayMatch = text.match(/^replay-file (.+)$/);
    if (replayMatch) { void replayFile(tid, replayMatch[1].trim()); return; }
    const reportMatch = text.match(/^report-file (.+)$/);
    if (reportMatch) {
      const messages = JSON.parse(fs.readFileSync(reportMatch[1].trim(), 'utf8'));
      messages.forEach((agentText, i) => {
        if (i > 0) {
          const mcp = { type: 'mcpToolCall', id: `mcp-report-${i}`, server: 'dispatch', tool: 'report_status', arguments: { state: 'done' } };
          notify('item/started', { threadId: tid, turnId: TURN, item: { ...mcp, status: 'inProgress' }, startedAtMs: 10 * i });
          notify('item/completed', { threadId: tid, turnId: TURN, item: { ...mcp, status: 'completed', result: { content: [] } }, completedAtMs: 10 * i + 1 });
        }
        const id = `msg-report-${i}`;
        const half = Math.ceil(agentText.length / 2);
        notify('item/started', { threadId: tid, turnId: TURN, item: { type: 'agentMessage', id, text: '', phase: 'commentary', memoryCitation: null }, startedAtMs: 10 * i + 2 });
        notify('item/agentMessage/delta', { threadId: tid, turnId: TURN, itemId: id, delta: agentText.slice(0, half) });
        notify('item/agentMessage/delta', { threadId: tid, turnId: TURN, itemId: id, delta: agentText.slice(half) });
        notify('item/completed', { threadId: tid, turnId: TURN, item: { type: 'agentMessage', id, text: agentText, phase: 'final_answer', memoryCitation: null }, completedAtMs: 10 * i + 3 });
      });
      notify('turn/completed', { threadId: tid, turn: { id: TURN, items: [], itemsView: 'notLoaded', status: 'completed', durationMs: 5 } });
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
    // `mcp <server> <tool>` — an MCP tool call that Codex (on-request) gates behind an
    // `mcpServer/elicitation/request` with `_meta.codex_approval_kind: 'mcp_tool_call'`, in the
    // live order (codex-cli 0.156.1): item/started mcpToolCall → the ServerRequest → item/completed.
    const mcpMatch = text.match(/^mcp (\S+) (\S+)$/i);
    // `elicit` — a REAL MCP elicitation (a form asking the user for data), not a tool approval.
    const elicitMatch = /^elicit$/i.test(text);
    if (mcpMatch) {
      const [, server, tool] = mcpMatch;
      notify('item/started', { threadId: tid, turnId: TURN, item: { type: 'mcpToolCall', id: 'mcp-1', server, tool, status: 'inProgress', arguments: {} }, startedAtMs: 3 });
      const reqId = serverReqId++;
      pendingApprovalThreadIds.set(reqId, tid);
      pendingApprovalMeta.set(reqId, { method: 'mcpServer/elicitation/request', itemType: 'mcpToolCall', itemId: 'mcp-1', server, tool });
      send({ jsonrpc: '2.0', id: reqId, method: 'mcpServer/elicitation/request', params: { threadId: tid, turnId: TURN, serverName: server, mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_description: 'd', tool_params: { a: 1 }, tool_params_display: [] }, message: `Allow the ${server} MCP server to run tool "${tool}"?`, requestedSchema: { type: 'object', properties: {} } } });
    } else if (elicitMatch) {
      const reqId = serverReqId++;
      pendingApprovalThreadIds.set(reqId, tid);
      pendingApprovalMeta.set(reqId, { method: 'mcpServer/elicitation/request', itemType: 'elicitation' });
      send({ jsonrpc: '2.0', id: reqId, method: 'mcpServer/elicitation/request', params: { threadId: tid, turnId: TURN, serverName: 'somesrv', mode: 'form', _meta: null, message: 'What is your email?', requestedSchema: { type: 'object', properties: { email: { type: 'string' } } } } });
    } else if (execMatch) {
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
    logRequest('turn/interrupt', msg.params);
    respond(msg.id, {});
    notify('turn/completed', { threadId: tid, turn: { id: msg.params?.turnId ?? TURN, items: [], itemsView: 'notLoaded', status: 'interrupted', durationMs: 5 } });
    return;
  }

  // Release a thread (real codex: unsubscribes it; app-server unloads it, and its MCP children,
  // once idle past thread_unload_delay_secs). Opt-in misbehaviour for the release tests:
  // CODEX_FAKE_UNSUB=hang never answers, =error answers with an RPC error.
  if (msg.method === 'thread/unsubscribe') {
    logRequest('thread/unsubscribe', msg.params);
    if (process.env.CODEX_FAKE_UNSUB === 'hang') return;
    if (process.env.CODEX_FAKE_UNSUB === 'error') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom' } }); return; }
    respond(msg.id, { status: 'unsubscribed' });
    return;
  }
  if (msg.method === 'thread/compact/start') { respond(msg.id, {}); return; }
  if (msg.method === 'model/list') {
    logRequest('model/list', msg.params);
    const eff = (list) => list.map((reasoningEffort) => ({ reasoningEffort, description: '' }));
    respond(msg.id, { data: [
      { model: 'gpt-6-astra', id: 'gpt-6-astra', defaultReasoningEffort: 'medium', supportedReasoningEfforts: eff(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) },
      { model: 'gpt-6-luna', id: 'gpt-6-luna', defaultReasoningEffort: 'low', supportedReasoningEfforts: eff(['low', 'medium', 'high', 'xhigh', 'max']) },
    ], nextCursor: null });
    return;
  }
  // Unknown requests still need a response so the client's pending map drains (logged for the tests).
  if (msg.id !== undefined && msg.method) { logRequest(msg.method, msg.params); respond(msg.id, {}); }
});
