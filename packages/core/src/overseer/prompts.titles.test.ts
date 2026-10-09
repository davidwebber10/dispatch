// The persona changes for ledger titles (titles and source panel spec 2026-10-09, Unit 4), Claude
// and Codex: the same lines in both.
import { describe, expect, it } from 'vitest';
import { buildCoordinatorPrompt } from './prompts.js';

const TITLE_LINES = [
  // Titles for the items that lack one, before each recap.
  'When ledger_list({ forRecap: true }) answers "Titles first", give each listed item a title with ledger_set_title, then ' +
    'call it again: that call did not mark the recap, and it does not ask twice. Otherwise call ledger_list({ forRecap: ' +
    'true }) once per recap: each call marks the recap. Give a title to each item in "Open items without a title" too.',
  // The ledger-number rule: the title, or the question when there is none.
  '- LEDGER NUMBERS: every ledger number in a reply carries its title, or its question when it has no title, for example ' +
    '"N53 — confirm the data retention terms". Never write a range of ledger numbers.',
  'Use the N-ID with its title, or its question when it has no title.',
  // The tools.
  'ledger_add({ kind, text, title, context?, options?, recommendation?, why?, default?, source?, note?, blocks?, mission?, author?, supersedes? })',
  'ledger_add_from_agent({ id, title, note?, blocks? })',
  '- ledger_set_title({ id, title }) — set or change the title of an item; set it once, and change it only with a reason.',
  'ledger_import({ items }) — once, at rollout: load open items and earlier decisions from your context; an open go, ' +
    'decide or do item needs a title.',
  // The title rules.
  'Every item needs a title: a short label that chips, card rows and recap lines show instead of the question. A title is ' +
    'one line, has at least 2 words and about 40 characters (50 at most), and is never only a code such as N41 or Q12, for ' +
    'example "Merge board PR #26".',
];

describe('overseer persona — ledger titles', () => {
  for (const harness of ['claude-code', 'codex']) {
    it(`${harness}: the title lines, the ledger-number rule and the tools`, () => {
      const p = buildCoordinatorPrompt({ harness });
      for (const line of TITLE_LINES) expect(p, line).toContain(line);
    });

    it(`${harness}: the old ledger-number rule is gone`, () => {
      const p = buildCoordinatorPrompt({ harness });
      expect(p).not.toContain('every ledger number in a reply carries its question or a short description');
      expect(p).not.toContain('Use the N-ID with its question.');
    });
  }
});
