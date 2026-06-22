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

  it('appends the secrets system prompt when one is injected (new + resume)', () => {
    const neu = claudeCodeProvider.buildNewCommand({ workDir: '/tmp', secretsMcp: { systemPrompt: 'Use Doppler for secrets' } });
    const i = neu.args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThan(-1);
    expect(neu.args[i + 1]).toBe('Use Doppler for secrets');

    const res = claudeCodeProvider.buildResumeCommand({ externalSessionId: 'abc', workDir: '/tmp', secretsMcp: { systemPrompt: 'Use Doppler' } });
    expect(res.args).toContain('--append-system-prompt');
  });

  it('omits --append-system-prompt when no secrets system prompt is set', () => {
    expect(claudeCodeProvider.buildNewCommand({ workDir: '/tmp', secretsMcp: {} }).args).not.toContain('--append-system-prompt');
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

  it('builds a status-hooks settings object targeting the events route', () => {
    const plan = claudeCodeProvider.buildStatusHooks!({ serverUrl: 'http://localhost:3456', terminalId: 'term-1', codexHelperPath: '/x' });
    const hooks = (plan!.claudeSettings as any).hooks;
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.Stop).toBeDefined();
    expect(JSON.stringify(hooks)).toContain('http://localhost:3456/api/events/claude/term-1');
  });

  it('injects --settings when status hooks are provided', () => {
    const cmd = claudeCodeProvider.buildNewCommand({ workDir: '/tmp', statusHooks: { claudeSettingsPath: '/tmp/h.json' } });
    expect(cmd.args).toContain('--settings');
    expect(cmd.args[cmd.args.indexOf('--settings') + 1]).toBe('/tmp/h.json');
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

  it('builds notify -c args and injects them before the subcommand', () => {
    const plan = codexProvider.buildStatusHooks!({ serverUrl: 'http://localhost:3456', terminalId: 'cx-1', codexHelperPath: '/opt/codex-notify.mjs' });
    expect(plan!.codexArgs![0]).toBe('-c');
    expect(plan!.codexArgs![1]).toContain('notify=');
    expect(plan!.codexArgs![1]).toContain('http://localhost:3456/api/events/codex/cx-1');

    const cmd = codexProvider.buildResumeCommand({ externalSessionId: 'xyz', workDir: '/tmp', statusHooks: { codexNotifyArgs: plan!.codexArgs } });
    // -c overrides must precede the `resume` subcommand.
    expect(cmd.args[0]).toBe('-c');
    expect(cmd.args[cmd.args.length - 2]).toBe('resume');
    expect(cmd.args[cmd.args.length - 1]).toBe('xyz');
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
