import { describe, expect, it } from 'vitest';
import { AGENT_PROMPTS, COORDINATOR_PROMPT, MODEL_FOR_TYPE, modelFor, systemPromptFor } from './prompts.js';

describe('fable review-gate agent types', () => {
  it('defines personas for design-reviewer and code-reviewer', () => {
    expect(AGENT_PROMPTS['design-reviewer']).toContain('Design Reviewer');
    expect(AGENT_PROMPTS['code-reviewer']).toContain('Code Reviewer');
  });

  it('routes both types to the fable model tier', () => {
    expect(MODEL_FOR_TYPE['design-reviewer']).toBe('fable');
    expect(MODEL_FOR_TYPE['code-reviewer']).toBe('fable');
    expect(modelFor({ agentType: 'design-reviewer' })).toBe('fable');
    expect(modelFor({ agentType: 'code-reviewer' })).toBe('fable');
  });

  it('systemPromptFor resolves the new personas', () => {
    expect(systemPromptFor({ agentType: 'design-reviewer' })).toBe(AGENT_PROMPTS['design-reviewer']);
    expect(systemPromptFor({ agentType: 'code-reviewer' })).toBe(AGENT_PROMPTS['code-reviewer']);
  });

  it('existing tiers are unchanged', () => {
    expect(MODEL_FOR_TYPE.coordinator).toBe('sonnet');
    expect(MODEL_FOR_TYPE.implementer).toBe('sonnet');
    expect(MODEL_FOR_TYPE.researcher).toBe('opus');
  });
});

describe('coordinator review gates', () => {
  it('the coordinator prompt teaches both gates and the skip criteria', () => {
    expect(COORDINATOR_PROMPT).toContain('design-reviewer');
    expect(COORDINATOR_PROMPT).toContain('code-reviewer');
    expect(COORDINATOR_PROMPT).toContain('SKIP both gates');
  });
});
