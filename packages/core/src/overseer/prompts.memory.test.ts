// The persona for the overseer memory scope (spec 2026-10-07, Unit 3).
import { describe, expect, it } from 'vitest';
import { AGENT_PROMPTS, COORDINATOR_PROMPT, buildCoordinatorPrompt, coordinatorMemoryLabelFor, systemPromptFor } from './prompts.js';

const MEMORY_PARAGRAPH = [
  'Your memory is your own folder',
  'It loads at each start.',
  'The project’s shared memory folder',
  'holds notes from the user’s own threads, and older notes of yours. It does not load by itself.',
  'Read it when the user asks, or when a task names or clearly overlaps one of the user’s threads.',
  'read_thread shows a thread’s full history.',
  'If you cannot read the folder, use read_thread and ask the user.',
  'Keep the origin: something you take from a thread is the thread’s, not yours and not the user’s decision.',
  'Name the thread when you use it.',
  'A ledger item from a thread needs the source kind "thread", and goes into the ledger only when the user says so.',
  'Write a shared note only when the user’s threads must know something, such as a decision they must respect or a fact about the project.',
  'Start it with "From the overseer:". One fact per note.',
];

const FOLDERS = { own: '/h/.claude/dispatch-overseer/-p/memory', shared: '/h/.claude/projects/-p/memory' };

// Unit 5: the rules are one line in the recap; the overseer applies the full list and does not paste it.
const RULES = [
  'ledger_list also returns the Project rules line, Running on defaults, Not yet triaged and a count line',
  'ledger_list also gives you the project rules in full, for your own use: apply them, and do not paste them.',
  '"show rules" → ledger_show({ rules: true }).',
  'ledger_show({ ids?, all?, rules? })',
];

describe('overseer persona — project rules as one line', () => {
  for (const harness of ['claude-code', 'codex']) {
    it(`${harness}: apply the rules, do not paste them; "show rules" prints them`, () => {
      const p = buildCoordinatorPrompt({ harness });
      for (const line of RULES) expect(p, line).toContain(line);
      expect(p).not.toContain('ledger_list also returns Project rules (your words)');
    });
  }
});

describe('overseer persona — memory scope', () => {
  for (const harness of ['claude-code', 'codex']) {
    it(`${harness}: carries the memory paragraph`, () => {
      const p = buildCoordinatorPrompt({ harness });
      for (const line of MEMORY_PARAGRAPH) expect(p, line).toContain(line);
      expect(p).toContain(`Your memory is your own folder, under ${coordinatorMemoryLabelFor(harness)}.`);
      expect(p).toContain('The project’s shared memory folder, under ~/.claude/projects,');
    });
  }

  it('claude-code: names its own folder root; the old "files under ~/.claude" sentence is gone', () => {
    expect(COORDINATOR_PROMPT).toContain('~/.claude/dispatch-overseer');
    expect(COORDINATOR_PROMPT).not.toContain('own memory files under ~/.claude.');
  });

  it("codex: its own folder label replaces the Claude overseer's; the shared Claude folder stays", () => {
    const p = buildCoordinatorPrompt({ harness: 'codex' });
    expect(p).not.toContain('~/.claude/dispatch-overseer');
    expect(p).toContain('Your memory is your own folder, under ~/.codex/dispatch-coordinator.');
    expect(p).not.toMatch(/~\/\.claude(?!\/projects)/);
  });

  it('with the folders of a start, the persona ends with their exact paths', () => {
    for (const harness of ['claude-code', 'codex']) {
      expect(buildCoordinatorPrompt({ harness, memoryFolders: FOLDERS })).toBe(
        `${buildCoordinatorPrompt({ harness })}\n\nYour memory folder: ${FOLDERS.own}. The project’s shared memory folder: ${FOLDERS.shared}.`,
      );
    }
  });

  it('systemPromptFor passes the folders to a coordinator only', () => {
    expect(systemPromptFor({ role: 'coordinator' }, 'claude-code', { memoryFolders: FOLDERS })).toBe(buildCoordinatorPrompt({ harness: 'claude-code', memoryFolders: FOLDERS }));
    expect(systemPromptFor({ agentType: 'planner' }, 'claude-code', { memoryFolders: FOLDERS })).toBe(AGENT_PROMPTS.planner);
    expect(systemPromptFor({ role: 'coordinator' }, 'claude-code')).toBe(COORDINATOR_PROMPT);
  });
});
