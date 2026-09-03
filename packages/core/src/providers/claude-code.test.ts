import { describe, expect, it } from 'vitest';
import { claudeCodeProvider } from './claude-code.js';

describe('claudeCodeProvider.buildStructuredCommand', () => {
  it('appends --disallowedTools with each name when disallowedTools is set', () => {
    const built = claudeCodeProvider.buildStructuredCommand!({
      workDir: '/w',
      disallowedTools: ['Agent', 'Task', 'Workflow'],
    });
    expect(built.command).toBe('claude');
    const i = built.args.indexOf('--disallowedTools');
    expect(i).toBeGreaterThan(-1);
    expect(built.args.slice(i + 1, i + 4)).toEqual(['Agent', 'Task', 'Workflow']);
  });

  it('omits --disallowedTools when unset or empty', () => {
    expect(claudeCodeProvider.buildStructuredCommand!({ workDir: '/w' }).args).not.toContain('--disallowedTools');
    expect(claudeCodeProvider.buildStructuredCommand!({ workDir: '/w', disallowedTools: [] }).args).not.toContain('--disallowedTools');
  });
});
