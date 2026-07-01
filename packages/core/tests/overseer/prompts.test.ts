import { it, expect } from 'vitest';
import { systemPromptFor, modelFor, MODEL_FOR_TYPE, COORDINATOR_PROMPT, AGENT_PROMPTS } from '../../src/overseer/prompts.js';

it('returns the coordinator prompt for role=coordinator', () => {
  expect(systemPromptFor({ role: 'coordinator' })).toBe(COORDINATOR_PROMPT);
  // role wins even if an agentType is also present
  expect(systemPromptFor({ role: 'coordinator', agentType: 'planner' })).toBe(COORDINATOR_PROMPT);
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
