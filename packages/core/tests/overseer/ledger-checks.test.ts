// The daemon's card checks (decision cards spec 2026-10-06, Unit 2). Pure parts only; the
// service-level checks are in ledger-service.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  cardFieldsError, missingCardFields, holdsSeveralDecisions, findProjectPath, gitWorktrees, onlyUserCanDecide,
  ONE_DECISION_ERROR, ONLY_USER_ERROR, sourceMissingError,
} from '../../src/overseer/ledger-checks.js';
import { DECIDE_CARD, GO_CARD } from './card-fixtures.js';

describe('the fixed texts', () => {
  it('match the spec word for word', () => {
    expect(cardFieldsError(['context (20 to 800 characters)', 'default']))
      .toBe('A decision card needs: context (20 to 800 characters), default. Add them and try again.');
    expect(ONE_DECISION_ERROR).toBe('One decision per card. Add each decision on its own.');
    expect(sourceMissingError('docs/nope.md')).toBe('The source does not exist in this project: docs/nope.md.');
    expect(ONLY_USER_ERROR).toBe('Only the user can decide this item.');
  });
});

describe('rule 1 — required fields for decide and go', () => {
  it('a full decide card and a full go card pass', () => {
    expect(missingCardFields('decide', DECIDE_CARD)).toEqual([]);
    expect(missingCardFields('go', GO_CARD)).toEqual([]);
  });

  it('names each missing field, in a fixed order', () => {
    expect(missingCardFields('decide', {})).toEqual([
      'context (20 to 800 characters)', 'options (at least 2, each { label, effect })', 'default', 'source',
    ]);
    expect(missingCardFields('go', {})).toEqual(['context (20 to 800 characters)', 'default', 'source']);
    const { why: _w, ...noWhy } = DECIDE_CARD;
    expect(missingCardFields('decide', noWhy)).toEqual(['why']);
    const { recommendation: _r, ...noRec } = DECIDE_CARD;
    expect(missingCardFields('decide', noRec)).toEqual(['recommendation (one of the option labels)']);
  });

  it('context must hold 20 to 800 characters', () => {
    expect(missingCardFields('decide', { ...DECIDE_CARD, context: 'Too short.' })).toEqual(['context (20 to 800 characters)']);
    expect(missingCardFields('decide', { ...DECIDE_CARD, context: 'x'.repeat(801) })).toEqual(['context (20 to 800 characters)']);
    expect(missingCardFields('decide', { ...DECIDE_CARD, context: 'x'.repeat(20) })).toEqual([]);
    expect(missingCardFields('decide', { ...DECIDE_CARD, context: 'x'.repeat(800) })).toEqual([]);
  });

  it('decide needs at least 2 options, each with a label and an effect; plain strings do not count', () => {
    const one = [{ label: 'A', effect: 'a' }];
    expect(missingCardFields('decide', { ...DECIDE_CARD, options: one, recommendation: 'A' })).toEqual(['options (at least 2, each { label, effect })']);
    expect(missingCardFields('decide', { ...DECIDE_CARD, options: ['A', 'B'], recommendation: 'A' })).toEqual(['options (at least 2, each { label, effect })']);
    expect(missingCardFields('decide', { ...DECIDE_CARD, options: [{ label: 'A', effect: 'a' }, { label: 'B' }], recommendation: 'A' }))
      .toEqual(['options (at least 2, each { label, effect })']);
  });

  it('go options are optional; given options need the recommendation and its reason', () => {
    expect(missingCardFields('go', { ...GO_CARD, options: [{ label: 'merge now', effect: 'ships today' }] }))
      .toEqual(['recommendation (one of the option labels)', 'why']);
    expect(missingCardFields('go', { ...GO_CARD, options: [{ label: 'merge now' }] })).toEqual(['options (each { label, effect })']);
  });

  it('the recommendation must equal one option label', () => {
    expect(missingCardFields('decide', { ...DECIDE_CARD, recommendation: 'A' })).toEqual(['recommendation (one of the option labels)']);
  });

  it('the source needs a known kind, and a ref for every kind but overseer', () => {
    expect(missingCardFields('go', { ...GO_CARD, source: { kind: 'wiki', ref: 'x' } })).toEqual(['source']);
    for (const kind of ['plan', 'doc', 'agent', 'pr', 'issue', 'user']) {
      expect(missingCardFields('go', { ...GO_CARD, source: { kind } }), kind).toEqual(['source']);
      expect(missingCardFields('go', { ...GO_CARD, source: { kind, ref: 'x' } }), kind).toEqual([]);
    }
    expect(missingCardFields('go', { ...GO_CARD, source: { kind: 'overseer' } })).toEqual([]);
  });

  it('"Nothing happens" is a valid default', () => {
    expect(missingCardFields('go', { ...GO_CARD, default: 'Nothing happens' })).toEqual([]);
  });
});

describe('rule 2 — one decision per card', () => {
  it('refuses a range of plan IDs', () => {
    for (const q of ['Approve LR-1..LR-26?', 'Accept D1 to D9?', 'Keep D2-D6 as they are?', 'Answer Q1–Q6?', 'Take LR-1 to 26?', 'Ship LR-3 through LR-5?', 'D1 … D4?']) {
      expect(holdsSeveralDecisions(q), q).toBe(true);
    }
  });

  it('refuses 3 or more plan-style IDs', () => {
    expect(holdsSeveralDecisions('Do D1, D4 and Q2 the same way?')).toBe(true);
    expect(holdsSeveralDecisions('Keep LR-12, LR-14 and LR-20?')).toBe(true);
  });

  it('a single LR-6 passes, and so do two IDs and plain questions', () => {
    expect(holdsSeveralDecisions('LR-6: how many clean nights before live mode?')).toBe(false);
    expect(holdsSeveralDecisions('Merge D1 before D2?')).toBe(false);
    expect(holdsSeveralDecisions('How many clean nights before live mode?')).toBe(false);
    expect(holdsSeveralDecisions('Merge PR #12, #13 and #14?')).toBe(false); // PR numbers are not plan IDs
    expect(holdsSeveralDecisions('Use UTF-8 for the export?')).toBe(false);
    expect(holdsSeveralDecisions('Run 5-10 nights?')).toBe(false); // a numeric range is not a range of IDs
  });
});

describe('rule 3 — a plan or doc path exists inside the project', () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-src-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-out-'));
    fs.mkdirSync(path.join(root, 'docs/plans'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/plans/readiness.md'), '# plan');
    fs.writeFileSync(path.join(outside, 'secret.md'), 'x');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('finds a relative path, and returns it in a normal form', () => {
    expect(findProjectPath('docs/plans/readiness.md', [root])).toBe('docs/plans/readiness.md');
    expect(findProjectPath('./docs/plans/../plans/readiness.md', [root])).toBe('docs/plans/readiness.md');
  });

  it('accepts an absolute path inside the project, refuses one outside it', () => {
    expect(findProjectPath(path.join(root, 'docs/plans/readiness.md'), [root])).toBe('docs/plans/readiness.md');
    expect(findProjectPath(path.join(outside, 'secret.md'), [root])).toBeNull();
  });

  it('refuses a path that escapes the project with ..', () => {
    const escape = path.relative(root, path.join(outside, 'secret.md')); // ../ledger-out-…/secret.md
    expect(escape.startsWith('..')).toBe(true);
    expect(findProjectPath(escape, [root])).toBeNull();
  });

  it('refuses a symlink inside the project that points outside it', () => {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'docs/link.md'));
    expect(findProjectPath('docs/link.md', [root])).toBeNull();
  });

  it('refuses a missing file and the project root itself', () => {
    expect(findProjectPath('docs/plans/nope.md', [root])).toBeNull();
    expect(findProjectPath('.', [root])).toBeNull();
    expect(findProjectPath('', [root])).toBeNull();
  });

  it('finds a file that exists only in a second root (a git worktree)', () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-wt-'));
    try {
      fs.mkdirSync(path.join(wt, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(wt, 'docs/only-here.md'), 'x');
      expect(findProjectPath('docs/only-here.md', [root])).toBeNull();
      expect(findProjectPath('docs/only-here.md', [root, wt])).toBe('docs/only-here.md');
    } finally { fs.rmSync(wt, { recursive: true, force: true }); }
  });

  it('gitWorktrees lists the worktrees of a real repository, and [] for a plain directory', () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { stdio: 'ignore' });
    expect(gitWorktrees(root)).toEqual([]);
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const wt = path.join(outside, 'wt');
    git('worktree', 'add', '-q', '-b', 'side', wt);
    const list = gitWorktrees(root).map((p) => fs.realpathSync(p));
    expect(list).toEqual(expect.arrayContaining([fs.realpathSync(root), fs.realpathSync(wt)]));
  });
});

describe('rule 4 — items only the user can decide', () => {
  const base = { kind: 'decide' as const, sourceKind: 'agent' as const, sentAt: null };
  it('a go item, a user-sourced item, and an item already sent to the user', () => {
    expect(onlyUserCanDecide({ ...base, kind: 'go' })).toBe(true);
    expect(onlyUserCanDecide({ ...base, sourceKind: 'user' })).toBe(true);
    expect(onlyUserCanDecide({ ...base, sentAt: '2026-10-06T10:00:00.000Z' })).toBe(true);
    expect(onlyUserCanDecide(base)).toBe(false);
  });
});
