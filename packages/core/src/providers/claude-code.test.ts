import { describe, expect, it } from 'vitest';
import { claudeCodeProvider, dispatchClaudeSettings } from './claude-code.js';

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
      expect(JSON.parse(args[i + 1])).toMatchObject({ autoMemoryDirectory: '/h/.claude/dispatch-overseer/-w/memory' });
      expect(args.filter((a) => a === '--settings')).toHaveLength(1);
    }
  });

  it('with no memory folder the one --settings holds only Dispatch\'s floor', () => {
    for (const autoMemoryDirectory of [undefined, '']) {
      const args = claudeCodeProvider.buildStructuredCommand!({ workDir: '/w', autoMemoryDirectory }).args;
      expect(args.filter((a) => a === '--settings')).toHaveLength(1);
      expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ env: { MCP_TIMEOUT: '30000' }, cleanupPeriodDays: 3650 });
    }
  });

  // One flag, because the CLI may keep only the last: the floor, the memory folder and the smart rules together.
  it('merges the floor, the memory folder and the smart rules into a single --settings', () => {
    const args = claudeCodeProvider.buildStructuredCommand!({ workDir: '/w', autoMemoryDirectory: '/m', smartApprovals: { settings: JSON.stringify({ permissions: { ask: ['Bash(rm:*)'] } }) } }).args;
    expect(args.filter((a) => a === '--settings')).toHaveLength(1);
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ env: { MCP_TIMEOUT: '30000' }, cleanupPeriodDays: 3650, autoMemoryDirectory: '/m', permissions: { ask: ['Bash(rm:*)'] } });
  });

  it('DISPATCH_MCP_TIMEOUT_MS changes the timeout; a junk value falls back to 30 seconds', () => {
    expect(dispatchClaudeSettings({ DISPATCH_MCP_TIMEOUT_MS: '45000' } as any).env.MCP_TIMEOUT).toBe('45000');
    expect(dispatchClaudeSettings({ DISPATCH_MCP_TIMEOUT_MS: 'abc' } as any).env.MCP_TIMEOUT).toBe('30000');
    expect(dispatchClaudeSettings({} as any).env.MCP_TIMEOUT).toBe('30000');
  });
});

describe('claudeCodeProvider --effort', () => {
  const secrets = undefined;
  it('passes --effort on new, resume and structured commands, and omits it when unset', () => {
    const base = { workDir: '/w', secretsMcp: secrets };
    expect(claudeCodeProvider.buildNewCommand({ ...base, effort: 'high' }).args).toEqual(expect.arrayContaining(['--effort', 'high']));
    expect(claudeCodeProvider.buildResumeCommand({ ...base, externalSessionId: 's', effort: 'xhigh' }).args).toEqual(expect.arrayContaining(['--effort', 'xhigh']));
    expect(claudeCodeProvider.buildStructuredCommand!({ workDir: '/w', effort: 'max' }).args).toEqual(expect.arrayContaining(['--effort', 'max']));
    expect(claudeCodeProvider.buildNewCommand(base).args).not.toContain('--effort');
    expect(claudeCodeProvider.buildResumeCommand({ ...base, externalSessionId: 's' }).args).not.toContain('--effort');
    expect(claudeCodeProvider.buildStructuredCommand!({ workDir: '/w' }).args).not.toContain('--effort');
  });
});
