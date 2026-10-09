// The persona changes for decision cards (decision cards spec 2026-10-06, Unit 7).
import { describe, expect, it } from 'vitest';
import { AGENT_PROMPTS, COORDINATOR_PROMPT, buildCoordinatorPrompt } from './prompts.js';
import { parseOwnerDecisionsBlock } from './owner-decisions.js';

const OVERSEER = [
  // The tiers.
  'Always the user’s: merge, deploy and release items; anything that reverses or widens a decision the user recorded; changes to production data; cost or spend; messages to people outside the team; adding or dropping scope.',
  'You may decide, and record it with ledger_decide_self: implementation details inside an approved plan; a choice between technical options of equal effect; names, test approach and order of work; questions that only affect the agents.',
  'When unsure: the user’s.',
  'Project rules in ledger_list override these default tiers.',
  // Triage in the turn the report arrives.
  'triage each one in the same turn',
  'ledger_add_from_agent sends it to the user',
  'ledger_decide_self records your own choice and its reason',
  'This is ledger work, not a message to the user: the Batch line still limits your reply. The user sees the result in the next recap.',
  // Naming.
  'Never name a decision by a plan ID or a range. Never write "it is in the plan". Use the N-ID with its question.',
  // Cards.
  'Post cards exactly as the daemon renders them.',
  // User commands.
  '"show N17" or "show all" → ledger_show.',
  '"reverse N21" → ledger_resolve to answered, with the user’s quote.',
  'A rule from the user → ledger_note with policy: true.',
  // Own decisions.
  'When you add a decide or go item yourself, fill every required field',
  'A low-level call of your own that no agent proposed: record it with ledger_decide_self without an id (text, the card fields, choice and reason). Do not ledger_add it first: ledger_add sends it to the user, and then only the user can decide it.',
  // Tools.
  'ledger_add_from_agent({ id, note?, blocks? })',
  'ledger_decide_self({ id?, text?, context?, options?, recommendation?, why?, default?, source?, choice, reason })',
  'ledger_mark_default({ id })',
  'ledger_show({ ids?, all?, rules? })',
  'ledger_note({ quote, reading?, mission?, policy? })',
];

const CODEX_MARKERS = [
  'Each type defaults to a sensible model tier ',
  'only to override that default when a task is unusually easy or hard for its role.\n',
  'MODEL ECONOMY: the per-type default model is often too big for the task. ',
  'status checks and "did last night',
  'the opus defaults for genuine investigation, planning, and judgment.',
  'when you hit a denial, spawn the right agent instead of retrying.\n\n',
];

describe('overseer persona — decision cards', () => {
  for (const harness of ['claude-code', 'codex']) {
    it(`${harness}: the tiers, the triage rule, the naming rules, the commands, and the new tools`, () => {
      const p = buildCoordinatorPrompt({ harness });
      for (const line of OVERSEER) expect(p, line).toContain(line);
      expect(p).toMatch(/ledger_add\(\{ kind, text, context\?, options\?, recommendation\?, why\?, default\?, source\?/);
    });
  }

  it('the six Codex marker strings stay in COORDINATOR_PROMPT', () => {
    for (const marker of CODEX_MARKERS) expect(COORDINATOR_PROMPT, marker).toContain(marker);
  });
});

describe('agent personas — the owner-decisions block instruction', () => {
  const WITH_BLOCK = ['planner', 'researcher', 'reviewer', 'design-reviewer', 'code-reviewer'] as const;

  for (const type of WITH_BLOCK) {
    it(`${type}: ends its report with the block when it has decisions for the owner, and none otherwise`, () => {
      const p = AGENT_PROMPTS[type];
      expect(p).toContain('```owner-decisions');
      expect(p).toContain('When your report has decisions for the owner, end your final message with this block');
      expect(p).toContain('No block when there are none.');
      for (const field of ['"id"', '"kind"', '"question"', '"context"', '"options"', '"label"', '"effect"', '"recommendation"', '"why"', '"default"', '"where"', '"path"', '"section"']) {
        expect(p, field).toContain(field);
      }
      expect(p).toContain('One decision per entry');
    });
  }

  it('the implementer has no block instruction', () => {
    expect(AGENT_PROMPTS.implementer).not.toContain('owner-decisions');
  });

  it('the example in the instruction is itself a block the daemon reads', () => {
    const parsed = parseOwnerDecisionsBlock(AGENT_PROMPTS.planner);
    expect(parsed.kind).toBe('ok');
    expect((parsed as { entries: unknown[] }).entries).toHaveLength(1);
  });
});
