import { describe, expect, test } from 'vitest';
import { encodeClaudeProjectDir } from '../../src/platform/encode.js';

// Every expectation below is a REAL directory name observed under ~/.claude/projects,
// paired with a cwd recorded inside that directory's own transcript. Verified against the
// whole local corpus: replacing every non-alphanumeric character resolved 37/37 project
// dirs, where the previous `/`-only rule managed 22/37.
describe('encodeClaudeProjectDir', () => {
  test('darwin: replaces "/" with "-"', () => {
    expect(encodeClaudeProjectDir('/Users/jdetamore/proj', 'darwin')).toBe('-Users-jdetamore-proj');
  });

  test('darwin: replaces "." too — a dot-directory collapses to a DOUBLE dash', () => {
    // The bug this pins: `/.claude` must become `--claude` (the slash AND the dot each
    // become a dash). The `/`-only rule produced `-.claude`, a directory that never
    // exists, so every worktree thread's transcript was unfindable.
    expect(encodeClaudeProjectDir('/Users/dw/Sites/dispatch/.claude/worktrees/status-truth', 'darwin'))
      .toBe('-Users-dw-Sites-dispatch--claude-worktrees-status-truth');
  });

  test('darwin: replaces "_" and "+" as well — it is not a slash/dot special case', () => {
    // Observed: a macOS temp path (underscore) and a worktree named with a plus.
    expect(encodeClaudeProjectDir('/private/var/folders/k7/xw2xpq2d4tb_4vxd3mv0208/T/live-ask-C9uSMV', 'darwin'))
      .toBe('-private-var-folders-k7-xw2xpq2d4tb-4vxd3mv0208-T-live-ask-C9uSMV');
    expect(encodeClaudeProjectDir('/Users/dw/Sites/dispatch/.claude/worktrees/fix+ask-question-card-collapse', 'darwin'))
      .toBe('-Users-dw-Sites-dispatch--claude-worktrees-fix-ask-question-card-collapse');
  });

  test('darwin: leaves an already-clean path alone (the common case must not regress)', () => {
    expect(encodeClaudeProjectDir('/Users/davidwebber/Sites/dispatch', 'darwin'))
      .toBe('-Users-davidwebber-Sites-dispatch');
  });
});
