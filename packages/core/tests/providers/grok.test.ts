import { describe, it, expect } from 'vitest';
import { grokProvider } from '../../src/providers/grok.js';
import { getProvider, listProviders } from '../../src/providers/registry.js';

/**
 * Every flag asserted here was read from `grok --help` on Grok 1.0.3, not from
 * documentation. Notably there is NO `--yolo`, which several third-party guides claim.
 */
describe('grok provider', () => {
  it('runs autonomously — bypassPermissions, the analogue of Claude skipping permissions', () => {
    const cmd = grokProvider.buildNewCommand({ workDir: '/tmp' });
    expect(cmd.command).toBe('grok');
    expect(cmd.args).toEqual(['--permission-mode', 'bypassPermissions']);
  });

  it('never emits --yolo, which is not a real Grok flag', () => {
    const all = [
      grokProvider.buildNewCommand({ workDir: '/tmp' }),
      grokProvider.buildResumeCommand({ externalSessionId: 'x', workDir: '/tmp' }),
      grokProvider.buildRunnerCommand({ workDir: '/tmp', prompt: 'p' }),
    ];
    for (const c of all) expect(c.args).not.toContain('--yolo');
  });

  it('passes an initial prompt positionally', () => {
    const cmd = grokProvider.buildNewCommand({ workDir: '/tmp', prompt: 'fix the bug' });
    expect(cmd.args).toEqual(['--permission-mode', 'bypassPermissions', 'fix the bug']);
  });

  it('pins the model with --model on new, and omits it otherwise', () => {
    const withModel = grokProvider.buildNewCommand({ workDir: '/tmp', model: 'grok-4.5' });
    const i = withModel.args.indexOf('--model');
    expect(i).toBeGreaterThan(-1);
    expect(withModel.args[i + 1]).toBe('grok-4.5');
    expect(grokProvider.buildNewCommand({ workDir: '/tmp' }).args).not.toContain('--model');
  });

  it('resumes by session id, still fully autonomous', () => {
    const cmd = grokProvider.buildResumeCommand({ externalSessionId: 'abc-123', workDir: '/tmp' });
    expect(cmd.command).toBe('grok');
    expect(cmd.args).toEqual(['--permission-mode', 'bypassPermissions', '--resume', 'abc-123']);
  });

  it('carries the model through a resume too', () => {
    const cmd = grokProvider.buildResumeCommand({ externalSessionId: 'abc', workDir: '/tmp', model: 'grok-4.5' });
    expect(cmd.args.indexOf('--model')).toBeLessThan(cmd.args.indexOf('--resume'));
    expect(cmd.args).toContain('grok-4.5');
  });

  it('runs headlessly with --single, which exits when the turn is done', () => {
    const cmd = grokProvider.buildRunnerCommand({ workDir: '/tmp', prompt: 'do the thing' });
    expect(cmd.args).toEqual(['--permission-mode', 'bypassPermissions', '--single', 'do the thing']);
  });

  it('does not claim a structured transport it cannot speak', () => {
    // `grok agent stdio` exists, but nothing translates ACP into the Claude-shaped event
    // stream yet — so Pretty must stay unavailable rather than spawn and hang.
    expect(grokProvider.buildStructuredCommand).toBeUndefined();
  });

  it('falls back to pty timing for status, having no notify-style hook', () => {
    expect(grokProvider.statusStrategy).toBe('pty-timing');
    expect(grokProvider.buildStatusHooks).toBeUndefined();
  });

  it('is reachable from the registry under the name the wire type uses', () => {
    expect(getProvider('grok')).toBe(grokProvider);
    expect(listProviders().map((p) => p.name)).toContain('grok');
  });

  it('presents a display name for the UI', () => {
    expect(grokProvider.displayName).toBe('Grok');
  });
});
