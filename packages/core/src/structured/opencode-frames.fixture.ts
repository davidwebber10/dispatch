/**
 * OpenCode ACP frames, captured VERBATIM from a live `opencode acp` (1.18.18) session
 * driving openrouter/z-ai/glm-5.2 — the probe ran `echo dispatch-probe-ok` and replied
 * "PROBE-DONE". Only ids/paths are shortened. The dialect deltas vs grok-frames.fixture:
 *   - tool_call carries only scaffolding rawInput ({cwd}); the REAL input arrives on
 *     later in_progress tool_call_updates
 *   - usage_update {used, size, cost} — Grok has no such update
 *   - NO turn_completed: the turn ends in the session/prompt RESPONSE (promptResult)
 */

export const toolCall = {
  method: 'session/update',
  params: {
    sessionId: 'ses_oc1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_9cb2dac0',
      title: 'bash',
      kind: 'execute',
      status: 'pending',
      locations: [{ path: '/tmp/oc-probe' }],
      rawInput: { cwd: '/tmp/oc-probe' },
    },
  },
};

export const toolCallInProgress = {
  method: 'session/update',
  params: {
    sessionId: 'ses_oc1',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_9cb2dac0',
      status: 'in_progress',
      title: 'echo dispatch-probe-ok',
      kind: 'execute',
      locations: [{ path: '/tmp/oc-probe' }],
      rawInput: { cwd: '/tmp/oc-probe', command: 'echo dispatch-probe-ok', description: 'Echo probe marker' },
    },
  },
};

export const toolCallCompleted = {
  method: 'session/update',
  params: {
    sessionId: 'ses_oc1',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_9cb2dac0',
      status: 'completed',
      title: 'echo dispatch-probe-ok',
      content: [{ type: 'content', content: { type: 'text', text: 'dispatch-probe-ok\n' } }],
      rawOutput: { output: 'dispatch-probe-ok\n', metadata: { output: 'dispatch-probe-ok\n', exit: 0, truncated: false } },
    },
  },
};

export const agentMessageChunk = {
  method: 'session/update',
  params: {
    sessionId: 'ses_oc1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_007b496d',
      content: { type: 'text', text: 'PROBE-DONE' },
    },
  },
};

export const usageUpdate = {
  method: 'session/update',
  params: {
    sessionId: 'ses_oc1',
    update: {
      sessionUpdate: 'usage_update',
      used: 8736,
      size: 1048576,
      cost: { amount: 0.0024469632, currency: 'USD' },
    },
  },
};

/** The session/prompt RESPONSE's result — OpenCode's turn boundary. */
export const promptResponse = {
  stopReason: 'end_turn',
  usage: { inputTokens: 1311, outputTokens: 6, totalTokens: 8742, cachedReadTokens: 7425 },
  _meta: {},
};

/** session/new response carries the model as a configOptions entry, not models.currentModelId. */
export const sessionNewResponse = {
  sessionId: 'ses_oc1',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'openrouter/z-ai/glm-5.2',
      options: [{ value: 'openrouter/z-ai/glm-5.2', name: 'OpenRouter/GLM-5.2' }],
    },
  ],
};
