import { it, expect } from 'vitest';
import { systemPromptFor, COORDINATOR_PROMPT, AGENT_PROMPTS } from '../../src/overseer/prompts.js';

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
