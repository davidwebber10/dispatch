import { describe, it, expect } from 'vitest';
import { codexProvider } from './codex.js';

// Review round 1 (PR #155): the effort the owner picked in Pretty is kept when the thread moves to the CLI.
describe('codexProvider --effort', () => {
  const base = { workDir: '/w' };
  it('passes the effort as a -c override before the subcommand, on new and resume', () => {
    const fresh = codexProvider.buildNewCommand({ ...base, model: 'gpt-6-astra', effort: 'ultra' }).args;
    expect(fresh).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="ultra"', '--model', 'gpt-6-astra']));
    const resumed = codexProvider.buildResumeCommand({ ...base, externalSessionId: 'abc', effort: 'max' }).args;
    expect(resumed.indexOf('model_reasoning_effort="max"')).toBeLessThan(resumed.indexOf('resume'));
    expect(resumed.slice(-2)).toEqual(['resume', 'abc']);
  });
  it('omits it when unset or not a plain word', () => {
    expect(codexProvider.buildNewCommand(base).args.join(' ')).not.toContain('model_reasoning_effort');
    expect(codexProvider.buildResumeCommand({ ...base, externalSessionId: 'a' }).args.join(' ')).not.toContain('model_reasoning_effort');
    expect(codexProvider.buildNewCommand({ ...base, effort: 'high"; rm' }).args.join(' ')).not.toContain('model_reasoning_effort');
  });
});
