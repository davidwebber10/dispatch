import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COORDINATOR_PROMPT, buildCoordinatorPrompt, coordinatorMemoryLabelFor } from './prompts.js';
import { coordinatorMemoryDirFor } from './coordinator-policy.js';

describe('buildCoordinatorPrompt', () => {
  it('the claude-code variant is byte-identical to the original COORDINATOR_PROMPT constant', () => {
    expect(buildCoordinatorPrompt({ harness: 'claude-code' })).toBe(COORDINATOR_PROMPT);
  });

  it('the codex variant names its dedicated memory subdir (never the bare Codex home) and never mentions ~/.claude', () => {
    const p = buildCoordinatorPrompt({ harness: 'codex' });
    expect(p).toContain('~/.codex/dispatch-coordinator');
    expect(p).not.toMatch(/~\/\.codex(?!\/dispatch-coordinator)/);
    expect(p).not.toContain('~/.claude');
  });

  it('the codex variant drops the Claude tier-alias teaching entirely', () => {
    const p = buildCoordinatorPrompt({ harness: 'codex' });
    expect(p).not.toMatch(/\bsonnet\b/i);
    expect(p).not.toMatch(/\bopus\b/i);
    expect(p).not.toMatch(/\bfable\b/i);
    expect(p).not.toMatch(/\bhaiku\b/i);
    // Replaced with harness-neutral wording, not silently dropped.
    expect(p).toContain("appropriate to the worker's harness");
  });

  it('the codex variant still teaches the review gates and orchestration tools (parity, not a rewrite)', () => {
    const p = buildCoordinatorPrompt({ harness: 'codex' });
    expect(p).toContain('design-reviewer');
    expect(p).toContain('code-reviewer');
    expect(p).toContain('spawn_agent');
    expect(p).toContain('queue_agent');
  });

  it('the codex variant tells the coordinator to delegate rather than retry on a declined repo-write/ship command', () => {
    const p = buildCoordinatorPrompt({ harness: 'codex' });
    expect(p.toLowerCase()).toContain('declined');
    expect(p).toContain('spawn_agent instead');
  });

  it('an unrecognized harness falls back to the claude-code variant', () => {
    expect(buildCoordinatorPrompt({ harness: 'grok' })).toBe(COORDINATOR_PROMPT);
  });

  // T3: the prompt LABEL (what the model is told) and the enforced DIR (what the policy allows)
  // are two separate maps. They must name the same directory per harness, or the coordinator is
  // told to write somewhere the membrane then denies (or vice versa). This test ties them.
  it('the enforced memory dir matches the prompt memory label for every coordinator harness', () => {
    for (const h of ['claude-code', 'codex'] as const) {
      const label = coordinatorMemoryLabelFor(h);
      expect(label).toBeDefined();
      const expanded = path.join(os.homedir(), (label as string).replace(/^~[/]?/, ''));
      expect(coordinatorMemoryDirFor(h)).toBe(expanded);
    }
  });
});
