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

  // Overseer memory scope (spec 2026-10-07, Unit 1): the overseer loads only its own memory folder.
  it('passes --settings with autoMemoryDirectory when a memory folder is set, on spawn and on resume', () => {
    for (const resumeSessionId of [undefined, 'sess-1']) {
      const args = claudeCodeProvider.buildStructuredCommand!({ workDir: '/w', autoMemoryDirectory: '/h/.claude/dispatch-overseer/-w/memory', resumeSessionId }).args;
      const i = args.indexOf('--settings');
      expect(i).toBeGreaterThan(-1);
      expect(JSON.parse(args[i + 1])).toEqual({ autoMemoryDirectory: '/h/.claude/dispatch-overseer/-w/memory' });
      expect(args.filter((a) => a === '--settings')).toHaveLength(1);
    }
  });

  it('omits --settings when no memory folder is set', () => {
    expect(claudeCodeProvider.buildStructuredCommand!({ workDir: '/w' }).args).not.toContain('--settings');
    expect(claudeCodeProvider.buildStructuredCommand!({ workDir: '/w', autoMemoryDirectory: '' }).args).not.toContain('--settings');
  });
});
