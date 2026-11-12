import { it, expect } from 'vitest';
import { systemPromptFor, modelFor, MODEL_FOR_TYPE, COORDINATOR_PROMPT, AGENT_PROMPTS, buildPeerPrompt, HOSTED_REPLY_RULE } from '../../src/overseer/prompts.js';

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

it('returns the coordinator prompt for role=coordinator', () => {
  expect(systemPromptFor({ role: 'coordinator' })).toBe(COORDINATOR_PROMPT);
  // role wins even if an agentType is also present
  expect(systemPromptFor({ role: 'coordinator', agentType: 'planner' })).toBe(COORDINATOR_PROMPT);
});

it('the coordinator persona is concise-directive aware but keeps orchestration instructions', () => {
  // The concise communication-style directive is present…
  expect(COORDINATOR_PROMPT).toContain('BE CONCISE');
  // …without dropping the core orchestration wiring.
  expect(COORDINATOR_PROMPT).toContain('spawn_agent');
  expect(COORDINATOR_PROMPT).toContain('answer_agent');
});

it('returns the typed-agent prompt for a known agentType', () => {
  expect(systemPromptFor({ agentType: 'planner' })).toBe(AGENT_PROMPTS.planner);
  expect(systemPromptFor({ agentType: 'implementer' })).toBe(AGENT_PROMPTS.implementer);
  expect(systemPromptFor({ agentType: 'researcher' })).toBe(AGENT_PROMPTS.researcher);
  expect(systemPromptFor({ agentType: 'reviewer' })).toBe(AGENT_PROMPTS.reviewer);
});

it('returns undefined for unknown / empty / missing config', () => {
  expect(systemPromptFor(undefined)).toBeUndefined();
  expect(systemPromptFor(null)).toBeUndefined();
  expect(systemPromptFor({})).toBeUndefined();
  expect(systemPromptFor({ agentType: 'gardener' })).toBeUndefined();
  expect(systemPromptFor({ role: 'operator' })).toBeUndefined();
  // mission alone (no role/agentType) injects no persona
  expect(systemPromptFor({ mission: 'ship auth' })).toBeUndefined();
});

it('modelFor resolves the per-type tier (sonnet for coordinator/implementer, opus for the rest)', () => {
  expect(modelFor({ role: 'coordinator' })).toBe('sonnet');
  expect(modelFor({ role: 'agent', agentType: 'implementer' })).toBe('sonnet');
  expect(modelFor({ role: 'agent', agentType: 'planner' })).toBe('opus');
  expect(modelFor({ role: 'agent', agentType: 'researcher' })).toBe('opus');
  expect(modelFor({ role: 'agent', agentType: 'reviewer' })).toBe('opus');
  // role wins over agentType (a coordinator carrying a stray agentType still runs sonnet)
  expect(modelFor({ role: 'coordinator', agentType: 'planner' })).toBe('sonnet');
  // matches the exported map
  expect(modelFor({ agentType: 'reviewer' })).toBe(MODEL_FOR_TYPE.reviewer);
});

it('modelFor honors an explicit config.model override, then falls through to undefined', () => {
  expect(modelFor({ role: 'coordinator', model: 'opus' })).toBe('opus');
  expect(modelFor({ agentType: 'implementer', model: 'haiku' })).toBe('haiku');
  expect(modelFor({ model: '  sonnet  ' })).toBe('sonnet'); // trimmed
  // no role / no agentType / no model → omit the flag
  expect(modelFor(undefined)).toBeUndefined();
  expect(modelFor(null)).toBeUndefined();
  expect(modelFor({})).toBeUndefined();
  expect(modelFor({ mission: 'ship auth' })).toBeUndefined();
  expect(modelFor({ agentType: 'gardener' })).toBeUndefined();
  expect(modelFor({ role: 'agent', model: '   ' })).toBeUndefined(); // blank override ignored, role 'agent' has no tier
});

// --- buildPeerPrompt: the peer/watch context block injected into eligible threads ---

const SAMPLE_CTX = {
  projectName: 'checkout-revamp',
  workingDir: '/work/checkout-revamp',
  selfLabel: 'Overseer',
  selfId: 't-overseer-1',
  peers: [
    { label: 'Fix login bug', type: 'claude-code', status: 'working' },
    { label: 'Migrate schema', type: 'codex', status: 'idle' },
  ],
};

it('buildPeerPrompt names the project, the thread\'s own identity, and every peer', () => {
  const prompt = buildPeerPrompt(SAMPLE_CTX);
  expect(prompt).toContain('checkout-revamp');
  expect(prompt).toContain('/work/checkout-revamp');
  expect(prompt).toContain('Overseer');
  expect(prompt).toContain('t-overseer-1');
  for (const peer of SAMPLE_CTX.peers) {
    expect(prompt).toContain(peer.label);
  }
});

it('buildPeerPrompt tells the thread the roster is a snapshot and list_threads is the live picture', () => {
  const prompt = buildPeerPrompt(SAMPLE_CTX);
  expect(prompt).toContain('list_threads');
  expect(prompt.toLowerCase()).toContain('snapshot');
});

it('buildPeerPrompt tells the thread to prefer watch_thread over polling read_thread', () => {
  const prompt = buildPeerPrompt(SAMPLE_CTX);
  expect(prompt).toContain('watch_thread');
  expect(prompt.toLowerCase()).toContain('polling');
  // The actual guidance: prefer watching over polling, framed as a cost/benefit — not
  // just a bare mention of both words in unrelated sentences.
  expect(prompt.toLowerCase()).toMatch(/prefer[^.]*watch_thread[^.]*(over|instead of)[^.]*poll/);
});

it('buildPeerPrompt states etiquette/limits: no ping-pong (rate cap), spawn depth cap, archive needs force', () => {
  const prompt = buildPeerPrompt(SAMPLE_CTX);
  expect(prompt.toLowerCase()).toContain('ping-pong');
  expect(prompt.toLowerCase()).toContain('rate');
  expect(prompt.toLowerCase()).toContain('depth');
  expect(prompt).toContain('force: true');
});

it('buildPeerPrompt renders a sensible "no peers yet" line for an empty roster, not a dangling header', () => {
  const prompt = buildPeerPrompt({ ...SAMPLE_CTX, peers: [] });
  // A real sentence acknowledging there are no peers right now…
  expect(prompt.toLowerCase()).toMatch(/no other threads|no peers/);
  // …not the non-empty roster's header left dangling with nothing under it.
  expect(prompt).not.toMatch(/Other threads in this project[^\n]*:\s*\n\s*(Peer tools|$)/);
  expect(prompt).not.toContain('- "');
});

it('buildPeerPrompt does not re-teach spawning — that is COORDINATOR_PROMPT\'s job', () => {
  const prompt = buildPeerPrompt(SAMPLE_CTX);
  expect(prompt).not.toContain('spawn_agent');
  expect(prompt.toLowerCase()).not.toContain('typed agent');
});

it("a coordinator's combined prompt contains COORDINATOR_PROMPT and the peer block exactly once each", () => {
  const peerBlock = buildPeerPrompt(SAMPLE_CTX);
  // Mirrors how service.ts assembles it: the peer block rides in the `prompts` array fed
  // to composeInjection (one --append-system-prompt), the persona rides in a separate one.
  const combined = [peerBlock, COORDINATOR_PROMPT].join('\n\n');
  expect(countOccurrences(combined, peerBlock)).toBe(1);
  expect(countOccurrences(combined, COORDINATOR_PROMPT)).toBe(1);
});

it('teaches report_status to every peer-eligible thread', () => {
  const prompt = buildPeerPrompt({ label: 'x', terminalId: 't1', sessionId: 's1', peers: [] } as any);
  expect(prompt).toContain('report_status');
  expect(prompt).toContain('LAST thing you do');
});

it('frames report_status as a status signal, not the channel that delivers a question to the human', () => {
  // Regression: the old wording ("put the question in `ask` … otherwise the human will never
  // see it") read as "ask IS how the human sees the question", so models routed the real
  // question into the tool and left the thread transcript empty — invisible in thread mode.
  const prompt = buildPeerPrompt({ label: 'x', terminalId: 't1', sessionId: 's1', peers: [] } as any);
  // It must tell the thread to put its content in its normal reply…
  expect(prompt).toMatch(/findings, answer, and any question ALWAYS go in your normal reply/i);
  expect(prompt).toMatch(/that is what the human reads/i);
  // …explain WHY (tool-call args are collapsed out of sight — the PTY Ctrl+O burial)…
  expect(prompt).toMatch(/collapsed out of sight/i);
  expect(prompt).toContain('Ctrl+O');
  // …and that summary/ask is a copy, never a substitute for saying it.
  expect(prompt).toMatch(/short COPY for the board/i);
  // The misleading old framing must be gone.
  expect(prompt).not.toContain('the human will never see it');
  expect(prompt).not.toContain('put the question in `ask`');
});

it('every agent type gets the test-run rule: full suite only after a code change, no killing, no head/tail', () => {
  for (const [type, prompt] of Object.entries(AGENT_PROMPTS)) {
    expect(prompt, type).toContain('if you changed code, run the test files your change touches, then the full suite once at the end');
    expect(prompt, type).toContain('If you did not change code, run single test files only');
    expect(prompt, type).toContain('Do not pipe a test run through head or tail. Write the output to a file, then read the file');
    expect(prompt, type).toContain('If a run that you did not start is alive, wait. Never kill a process that you did not start');
    expect(prompt, type).not.toMatch(/kill it by PID/i);
  }
});

it('every agent prompt asks for the absolute path and branch of each doc it writes', () => {
  for (const p of Object.values(AGENT_PROMPTS)) {
    expect(p).toMatch(/Doc: .*absolute path.*branch/s);
    // It must not compete with "make it the last thing you say" (the summary rule).
    expect(p).toContain('put one line per doc in your final report');
    expect(p).not.toContain('end your report with');
  }
});

it('buildPeerPrompt ends a turn with one short closing line after report_status, never an empty message or a repeat', () => {
  // An empty last message makes Claude Code ask the model to continue, and it wrote its answer twice (2026-11-11).
  const p = buildPeerPrompt({ projectName: 'P', workingDir: '/w', selfLabel: 'me', selfId: 'id-1', peers: [] });
  expect(p).toMatch(/one short closing line/i);
  expect(p).toMatch(/never repeat/i);
  expect(p).not.toMatch(/write nothing more/i);
  // The same two branches and the same guard as the tool result and the tool description.
  expect(p).toMatch(/if you have not written your reply yet, write it now/i);
  expect(p).toMatch(/question nobody asked/i);
});

it('agent prompts keep the summary in the reply, not in the closing line', () => {
  for (const prompt of Object.values(AGENT_PROMPTS)) expect(prompt).not.toMatch(/make it the last thing you say/i);
});

// Hosted reply rule: the person reads only the reply, never the thinking or the status card.
it('buildPeerPrompt on a hosted box: the reply is the answer; report_status is a one-line summary after it', () => {
  const local = buildPeerPrompt(SAMPLE_CTX);
  const hosted = buildPeerPrompt({ ...SAMPLE_CTX, hosted: true });
  expect(hosted).toContain(HOSTED_REPLY_RULE);
  expect(local).not.toContain('YOUR REPLY IS THE ANSWER');
  expect(hosted).not.toContain('a STATUS signal for how your turn is');
  // Everything else is the same text.
  expect(hosted.replace(HOSTED_REPLY_RULE, '')).toBe(local.slice(0, local.indexOf('- report_status(')) + local.slice(local.indexOf('Etiquette and limits')));
  expect(HOSTED_REPLY_RULE).toMatchInlineSnapshot(`
    "YOUR REPLY IS THE ANSWER. The person reads only your reply text and what it shows (tables, charts, files). Your thinking, your tool calls and report_status are not shown as the answer. So every turn ends with a reply that holds the answer itself, in plain words: the facts that were asked for. For a record you looked up, give its key fields (for an order: number, date, status, customer, total, lines, shipping). When there are rows (order lines, lists, rankings), show them as a table with the \`display\` tools. Never reply only "see above", "that is the full record" or a pointer to work the person cannot see.
    - report_status({ state, summary, ask?, blocker? }) — a one-line summary for the thread list, never the answer. Order of each turn: write the reply with the answer, then call report_status as the last tool (\`done\`, \`needs_you\` when the person must act, \`blocked\` when you wait on another thread), then end with one short closing line. Before you call it, check that your reply text already holds the answer; if it does not, write the answer first.

    "
  `);
});
