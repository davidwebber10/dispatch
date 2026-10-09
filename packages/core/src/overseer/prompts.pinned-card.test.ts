// The persona changes for the pinned card (pinned card spec 2026-10-08, Unit 5), Claude and Codex.
import { describe, expect, it } from 'vitest';
import { buildCoordinatorPrompt } from './prompts.js';

const RECAP_FORMAT = [
  'The recap is news, not the ledger: about 15 lines at most, in this order:',
  '1. A header line: <project> · <time> · <n> decisions, <n> tests, <n> agents working',
  '2. New — paste the "New" lines from ledger_list.',
  '3. Running — one line per agent, from list_agents, with what happens when it finishes.',
  '4. Done — one line per finished piece of work, with PR numbers and links, then the "Decided" lines from ledger_list.',
  'End with the count line from ledger_list.',
  'Needs you now, your tests and actions, defaults and parked items stay on the pinned card: do not paste or rewrite them.',
  'ledger_list returns two parts: "Paste this into the recap" (the New lines, the Decided lines and the count line: paste them as is)',
];

const ONE_LINE = [
  'or record a new question with ledger_add and post the one line it returns.',
  'call ledger_add, then post the one line it returns, as is: the full card is on the pinned card.',
  'Returns its ID and one line to post as is; the user sees the full card on the pinned card.',
];

const LEDGER_NUMBERS = [
  '- LEDGER NUMBERS: every ledger number in a reply carries its question or a short description, for example "N53 — confirm the data retention terms". Never write a range of ledger numbers.',
];

// The user cannot keep plan codes in mind either: a code carries its short name.
const PLAN_CODES =
  'Never write a range of ledger numbers. When you name a plan question or a build task by its code (for example Q11 or A11), ' +
  'add its short name, for example "A11 (import confirmation)", not only the code.\n';

const INTERIM ='"🕒 Interim recap due" notice arrives (new items wait on the user: post the short recap and mark it "interim")';

describe('overseer persona — the pinned card', () => {
  for (const harness of ['claude-code', 'codex']) {
    it(`${harness}: the recap format, the one-line rule, the ledger-number rule and the interim wording`, () => {
      const p = buildCoordinatorPrompt({ harness });
      for (const line of [...RECAP_FORMAT, ...ONE_LINE, ...LEDGER_NUMBERS, INTERIM]) expect(p, line).toContain(line);
    });

    it(`${harness}: a plan question or build task named by its code carries its short name, in the ledger-number rule`, () => {
      expect(buildCoordinatorPrompt({ harness })).toContain(PLAN_CODES);
    });

    it(`${harness}: the old paste-the-ledger instructions are gone`, () => {
      const p = buildCoordinatorPrompt({ harness });
      for (const old of [
        '2. Needs you now — paste from ledger_list.', '3. Your tests and actions — paste from ledger_list.',
        '6. Parked — paste from ledger_list.', 'at most about 25 lines', 'post only that item',
        'then post the card it returns, as is', 'Returns its ID and the card to post as is.',
        'ledger_list also returns the Project rules line',
      ]) expect(p, old).not.toContain(old);
    });
  }
});
