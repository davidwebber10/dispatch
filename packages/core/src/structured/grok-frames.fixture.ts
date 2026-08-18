// packages/core/src/structured/grok-frames.fixture.ts
//
// REAL frames captured from `grok agent stdio` (Grok 1.0.4, ACP protocolVersion 1) during the
// 2026-08-14 spike, trimmed to the fields the translator reads plus enough context to stay
// honest. Session/prompt ids shortened. If a Grok release changes these shapes, re-capture
// with a probe script (spawn `grok agent stdio`, initialize → session/new → session/prompt)
// rather than hand-editing.

/** A streamed assistant-prose delta (live turns stream word-by-word). */
export const agentMsgChunk1 = {
  method: 'session/update',
  params: {
    sessionId: '01a00331-0c34-7c42-92fb-b85a96b13852',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PROBE' } },
    _meta: { totalTokens: 9711, eventId: 'ev-39', promptId: 'p-1', updateType: 'AgentMessageChunk', chunkId: 36 },
  },
};

export const agentMsgChunk2 = {
  method: 'session/update',
  params: {
    sessionId: '01a00331-0c34-7c42-92fb-b85a96b13852',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '-OK' } },
    _meta: { totalTokens: 9711, eventId: 'ev-40', promptId: 'p-1', updateType: 'AgentMessageChunk', chunkId: 37 },
  },
};

export const thoughtChunk = {
  method: 'session/update',
  params: {
    sessionId: '01a00331-0c34-7c42-92fb-b85a96b13852',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'The user wants' } },
    _meta: { totalTokens: 9715, eventId: 'ev-4', promptId: 'p-1', updateType: 'AgentThoughtChunk', chunkId: 1 },
  },
};

/** The live echo of the prompt we just sent — the manager synthesizes its own echo, so the
 *  translator must IGNORE this outside replay. */
export const userMsgChunkLive = {
  method: 'session/update',
  params: {
    sessionId: '01a00331-0c34-7c42-92fb-b85a96b13852',
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Run the shell command `echo probe-tool-ok` and tell me its output.' },
      _meta: { modelId: 'grok-4.6', promptIndex: 0 },
    },
    _meta: { eventId: 'ev-2' },
  },
};

/** The same shape during a session/load replay (note `isReplay`). */
export const userMsgChunkReplay = {
  method: 'session/update',
  params: {
    sessionId: '01a0033b-6245-7710-a3ea-e6d9fd8df854',
    update: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Create a file /tmp/grok-probe-perm.txt containing "x" using the shell. Then stop.' },
      _meta: { modelId: 'grok-4.6', promptIndex: 0 },
    },
    _meta: { eventId: 'ev-2', isReplay: true },
  },
};

/** Replayed agent prose arrives as ONE whole-message chunk per agent message. */
export const agentMsgChunkReplay = {
  method: 'session/update',
  params: {
    sessionId: '01a0033b-6245-7710-a3ea-e6d9fd8df854',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "I'll create `/tmp/grok-probe-perm.txt` with the shell, then stop." } },
    _meta: { totalTokens: 9719, eventId: 'ev-74', promptId: 'p-2', updateType: 'AgentMessageChunk', isReplay: true },
  },
};

export const toolCall = {
  method: 'session/update',
  params: {
    sessionId: '01a00331-0c34-7c42-92fb-b85a96b13852',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-8c526644-0',
      title: 'run_terminal_command',
      rawInput: { command: 'echo probe-tool-ok', description: 'Run echo probe-tool-ok command' },
      _meta: { 'x.ai/tool': { version: 1, name: 'run_terminal_command', kind: 'execute', namespace: 'grok_build', label: 'Run Command', read_only: false } },
    },
    _meta: { eventId: 'ev-36', updateType: 'ToolCall', updateParams: { toolCallId: 'call-8c526644-0', status: 'Pending' } },
  },
};

/** Mid-execution progress — MUST NOT emit a tool_result yet. */
export const toolCallUpdateProgress = {
  method: 'session/update',
  params: {
    sessionId: '01a00331-0c34-7c42-92fb-b85a96b13852',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-8c526644-0',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'probe-tool-ok\n' } }],
      rawOutput: { type: 'Bash', output_for_prompt: 'probe-tool-ok\n', exit_code: 0, command: 'echo probe-tool-ok', truncated: false },
    },
  },
};

export const toolCallUpdateCompleted = {
  method: 'session/update',
  params: {
    sessionId: '01a00331-0c34-7c42-92fb-b85a96b13852',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-8c526644-0',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'probe-tool-ok\n' } }],
      rawOutput: { type: 'Bash', output_for_prompt: 'exit: 0\nprobe-tool-ok\n', exit_code: 0, command: 'echo probe-tool-ok', truncated: false },
    },
    _meta: { eventId: 'ev-38', updateType: 'ToolCallUpdate' },
  },
};

/** Per-model-call usage. `input_tokens` is the WHOLE context the call sent (cache included). */
export const responseCompleted = {
  method: '_x.ai/session_notification',
  params: {
    sessionId: '01a00331-0c34-7c42-92fb-b85a96b13852',
    update: {
      sessionUpdate: 'response_completed',
      usage: { input_tokens: 16952, output_tokens: 45, cache_read_input_tokens: 3072, cache_creation_input_tokens: 0, reasoning_tokens: 38 },
    },
  },
};

/** The turn boundary, with the turn's aggregate usage. Arrives via the `_x.ai/session_notification`
 *  method live and `_x.ai/session/update` in a replay — route by sessionUpdate, never by method. */
export const turnCompleted = {
  method: '_x.ai/session_notification',
  params: {
    sessionId: '01a00331-0c34-7c42-92fb-b85a96b13852',
    update: {
      sessionUpdate: 'turn_completed',
      prompt_id: 'p-1',
      stop_reason: 'end_turn',
      usage: {
        inputTokens: 40247, outputTokens: 125, totalTokens: 40372, cachedReadTokens: 25856,
        cacheCreationTokens: 0, reasoningTokens: 57, modelCalls: 2, apiDurationMs: 3101, costUsdTicks: 72182000,
        modelUsage: { 'grok-4.6-build': { inputTokens: 40247, outputTokens: 125 } }, numTurns: 2,
      },
    },
    _meta: { eventId: 'ev-93' },
  },
};

/**
 * The ACP permission request (server→client, carries an `id` that must be answered). NOT
 * captured live — `grok agent stdio`'s default mode ran tools without asking in the spike —
 * built from the ACP schema (agentclientprotocol.com, session/request_permission) so the
 * membrane still answers correctly if a Grok mode ever emits one.
 */
export const requestPermission = {
  method: 'session/request_permission',
  id: 11,
  params: {
    sessionId: '01a00331-0c34-7c42-92fb-b85a96b13852',
    toolCall: { toolCallId: 'call-8c526644-0', title: 'run_terminal_command', kind: 'execute', rawInput: { command: 'rm -rf /tmp/x' } },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
  },
};
