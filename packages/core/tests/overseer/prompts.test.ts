import { it, expect } from 'vitest';
import { systemPromptFor, modelFor, MODEL_FOR_TYPE, COORDINATOR_PROMPT, AGENT_PROMPTS, buildPeerPrompt } from '../../src/overseer/prompts.js';

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
