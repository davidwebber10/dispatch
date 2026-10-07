import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COORDINATOR_PROMPT, buildCoordinatorPrompt, coordinatorMemoryLabelFor } from './prompts.js';
import { coordinatorMemoryDirFor } from './coordinator-policy.js';

describe('buildCoordinatorPrompt', () => {
  it('the claude-code variant is byte-identical to the original COORDINATOR_PROMPT constant', () => {
    expect(buildCoordinatorPrompt({ harness: 'claude-code' })).toBe(COORDINATOR_PROMPT);
  });

  // Overseer memory scope (spec 2026-10-07): the Codex overseer may read and write the project's
  // shared Claude folder (~/.claude/projects/…), so that is the only ~/.claude path it names.
  it('the codex variant names its dedicated memory subdir (never the bare Codex home) and mentions ~/.claude only as the shared folder', () => {
    const p = buildCoordinatorPrompt({ harness: 'codex' });
    expect(p).toContain('~/.codex/dispatch-coordinator');
    expect(p).not.toMatch(/~\/\.codex(?!\/dispatch-coordinator)/);
    expect(p).not.toContain('~/.claude/dispatch-overseer');
    expect(p).not.toMatch(/~\/\.claude(?!\/projects)/);
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

  it('the codex variant says only the dispatch MCP tools are available (Astra finding 2)', () => {
    const p = buildCoordinatorPrompt({ harness: 'codex' });
    expect(p).toContain('Use only your "dispatch" MCP tools');
    expect(COORDINATOR_PROMPT).not.toContain('Use only your "dispatch" MCP tools'); // Claude keeps its MCP tools
  });

  // A coordinator that lost the tool schema to a context compaction still has this prompt. It
  // spawned gpt-6-astra reviewers with model alone, and they landed on claude-code (2026-09-29).
  it('every variant documents harness in the spawn_agent and queue_agent signatures', () => {
    for (const h of ['claude-code', 'codex']) {
      const p = buildCoordinatorPrompt({ harness: h });
      expect(p).toContain('spawn_agent({ agentType, name?, task, mission?, model?, harness?, ledgerIds? })');
      expect(p).toContain('queue_agent({ agentType, name?, task, mission?, dependsOn?, model?, harness?, ledgerIds? })');
      expect(p).toContain('message_agent({ agentId, text, ledgerIds? })');
      expect(p).toContain('The model never picks the harness');
      expect(p).toContain('harness: "codex", model: "gpt-6-astra"');
    }
  });

  // The codex variant is built with indexOf/replace on these exact strings. If an edit to
  // COORDINATOR_PROMPT drops one, the codex replacement silently stops happening.
  it('every string the codex variant replaces is still in COORDINATOR_PROMPT', () => {
    for (const marker of [
      'Each type defaults to a sensible model tier ',
      'only to override that default when a task is unusually easy or hard for its role.\n',
      'MODEL ECONOMY: the per-type default model is often too big for the task. ',
      'status checks and "did last night',
      'the opus defaults for genuine investigation, planning, and judgment.',
      'when you hit a denial, spawn the right agent instead of retrying.\n\n',
    ]) {
      expect(COORDINATOR_PROMPT, marker).toContain(marker);
    }
  });

  it('the codex variant differs from the claude variant at every replacement', () => {
    const p = buildCoordinatorPrompt({ harness: 'codex' });
    expect(p).not.toContain('Each type defaults to a sensible model tier ');
    expect(p).toContain('Each agent type has a sensible default model');
    expect(p).toContain("Pass `model` with a smaller/cheaper model id appropriate to the worker's harness when you spawn: status checks");
    expect(p).not.toContain('the opus defaults for genuine investigation');
    expect(p).toContain('the stronger default models for genuine investigation, planning, and judgment.');
    expect(p).toContain('spawn the right agent instead of retrying. On this harness specifically:');
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
