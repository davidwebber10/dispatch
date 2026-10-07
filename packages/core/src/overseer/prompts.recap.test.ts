// The persona contract for structured recaps and the decision ledger (structured-recap spec, Unit 6).
import { describe, expect, it } from 'vitest';
import { buildCoordinatorPrompt } from './prompts.js';

const CONTRACT = [
  'ends with a Batch line from the daemon. Follow it',
  'do not post a recap — write at most one line',
  'Call read_agent ONCE when you need an agent’s content to act',
  'REPORTING: report to the user in one recap per settled batch, not one reply per agent turn.',
  '"🕒 Interim recap due"',
  'when the user says "recap" — that word means: post this format now.',
  'at most about 25 lines',
  '1. A header: <project> · <time> · <n> decisions, <n> tests, <n> agents working',
  '2. Needs you now — paste from ledger_list.',
  '3. Your tests and actions — paste from ledger_list.',
  '4. Running — from list_agents, with what happens when each finishes.',
  '5. Done since the last recap',
  'No evidence sections; give the evidence only when the user asks.',
  '6. Parked — paste from ledger_list.',
  'never write "your rule", "you decided", "you said" or "you approved" except when you paste a ledger line that has a quote.',
  'A "yes" approves only the item text.',
  'A message that starts with "ok" does not agree with, answer or approve anything by that word',
  '"ok" never authorizes a merge, a push to a protected branch, a release or a deploy.',
  'Pass ledgerIds to agents; do not restate the user’s decisions in your own words as the owner’s rule.',
  'Every question to the user goes into the ledger first',
  'Do not save a proposal as a standing rule in memory before the user approves it. When you save a rule, include the user’s quote.',
  'After 3 days with no answer, ask once whether to keep or park an item.',
  'If your context starts with a continuation summary, call ledger_list before you answer.',
  'End each turn with report_status: needs_you when open go or decide items exist; blocked while your agents still work and nothing needs the user; otherwise done.',
  'For a go item, ask the user to answer with its ID or the action word (for example "N12: merge"); a bare "yes" fails the daemon check.',
];

describe('coordinator persona — structured recap contract', () => {
  for (const harness of ['claude-code', 'codex']) {
    it(`${harness}: carries every contract line and drops "synthesize and report to the user"`, () => {
      const p = buildCoordinatorPrompt({ harness });
      for (const line of CONTRACT) expect(p, line).toContain(line);
      expect(p).not.toContain('synthesize and report to the user');
      for (const tool of ['ledger_add(', 'ledger_resolve(', 'ledger_note(', 'ledger_list(', 'ledger_import(']) expect(p).toContain(tool);
    });
  }
});
