import { describe, it, expect } from 'vitest';
import { claudeCodeProvider } from '../../src/providers/claude-code.js';
import { codexProvider } from '../../src/providers/codex.js';
import { getProvider } from '../../src/providers/registry.js';

describe('claude-code provider', () => {
  it('builds new command without prompt', () => {
    const cmd = claudeCodeProvider.buildNewCommand({ workDir: '/tmp' });
    expect(cmd.command).toBe('claude');
    expect(cmd.args).toEqual(['--dangerously-skip-permissions']);
  });

  it('builds new command with prompt', () => {
    const cmd = claudeCodeProvider.buildNewCommand({ workDir: '/tmp', prompt: 'fix bug' });
    expect(cmd.command).toBe('claude');
    expect(cmd.args).toEqual(['--dangerously-skip-permissions', 'fix bug']);
  });

  it('builds resume command', () => {
    const cmd = claudeCodeProvider.buildResumeCommand({ externalSessionId: 'abc', workDir: '/tmp' });
    expect(cmd.command).toBe('claude');
    expect(cmd.args).toEqual(['--dangerously-skip-permissions', '-r', 'abc']);
  });

  it('builds an autonomous runner command (headless --print with the prompt)', () => {
    const cmd = claudeCodeProvider.buildRunnerCommand({ workDir: '/tmp', prompt: 'fix bug' });
    expect(cmd.command).toBe('claude');
    // Runs headlessly and exits on completion, skipping permission prompts.
    expect(cmd.args).toContain('--print');
    expect(cmd.args).toContain('--dangerously-skip-permissions');
    // Prompt is passed as a launch arg (and is the final positional).
    expect(cmd.args[cmd.args.length - 1]).toBe('fix bug');
  });

  it('has hooks status strategy', () => {
    expect(claudeCodeProvider.statusStrategy).toBe('hooks');
  });

  it('builds hooks config', () => {
    const config = claudeCodeProvider.buildHooksConfig!({ serverUrl: 'http://localhost:3456', sessionId: 'sess-1' });
    expect(config.hooks).toBeDefined();
  });
});

describe('codex provider', () => {
  it('builds new command', () => {
    const cmd = codexProvider.buildNewCommand({ workDir: '/tmp' });
    expect(cmd.command).toBe('codex');
  });

  it('builds resume command', () => {
    const cmd = codexProvider.buildResumeCommand({ externalSessionId: 'xyz', workDir: '/tmp' });
    expect(cmd.command).toBe('codex');
    expect(cmd.args).toEqual(['resume', 'xyz']);
  });

  it('builds an autonomous runner command (codex exec with the prompt)', () => {
    const cmd = codexProvider.buildRunnerCommand({ workDir: '/tmp', prompt: 'fix bug' });
    expect(cmd.command).toBe('codex');
    // `codex exec` runs non-interactively and exits on completion.
    expect(cmd.args[0]).toBe('exec');
    expect(cmd.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd.args[cmd.args.length - 1]).toBe('fix bug');
  });

  it('has pty-timing status strategy', () => {
    expect(codexProvider.statusStrategy).toBe('pty-timing');
  });
});

describe('registry', () => {
  it('finds claude-code', () => {
    expect(getProvider('claude-code')).toBe(claudeCodeProvider);
  });

  it('finds codex', () => {
    expect(getProvider('codex')).toBe(codexProvider);
  });

  it('throws for unknown provider', () => {
    expect(() => getProvider('unknown' as any)).toThrow();
  });
});
