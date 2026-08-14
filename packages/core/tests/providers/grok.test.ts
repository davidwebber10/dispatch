import { describe, it, expect } from 'vitest';
import { grokProvider } from '../../src/providers/grok.js';
import { getProvider, listProviders } from '../../src/providers/registry.js';
import { claudeCodeProvider } from '../../src/providers/claude-code.js';
import { codexProvider } from '../../src/providers/codex.js';

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

describe('grok assigns its own session id', () => {
  it('declares that it assigns the id rather than discovering it', () => {
    // Claude and Codex must DISCOVER the id after spawn (Claude even has an ambiguity
    // heuristic for two sessions born at once). Grok's `--session-id` lets us name it up
    // front, which cannot miss and cannot be ambiguous.
    expect(grokProvider.assignsSessionId).toBe(true);
  });

  it('passes the assigned id with --session-id', () => {
    const cmd = grokProvider.buildNewCommand({ workDir: '/tmp', sessionId: 'f0ba1c3e-0000-4000-8000-000000000001' });
    const i = cmd.args.indexOf('--session-id');
    expect(i).toBeGreaterThan(-1);
    expect(cmd.args[i + 1]).toBe('f0ba1c3e-0000-4000-8000-000000000001');
  });

  it('omits --session-id when none is assigned', () => {
    expect(grokProvider.buildNewCommand({ workDir: '/tmp' }).args).not.toContain('--session-id');
  });

  it('keeps the id ahead of the prompt, which is positional', () => {
    const cmd = grokProvider.buildNewCommand({ workDir: '/tmp', sessionId: 'abc', prompt: 'fix the bug' });
    expect(cmd.args.indexOf('--session-id')).toBeLessThan(cmd.args.indexOf('fix the bug'));
    expect(cmd.args[cmd.args.length - 1]).toBe('fix the bug');
  });

  it('never sends --session-id on a resume, where it means something else', () => {
    // `-s` names a NEW conversation; resuming with it is only valid alongside
    // --fork-session, which would silently fork instead of resuming.
    const cmd = grokProvider.buildResumeCommand({ externalSessionId: 'abc', workDir: '/tmp' });
    expect(cmd.args).not.toContain('--session-id');
    expect(cmd.args).toContain('--resume');
  });

  it('leaves the other providers discovering their id, as before', () => {
    expect(claudeCodeProvider.assignsSessionId).toBeFalsy();
    expect(codexProvider.assignsSessionId).toBeFalsy();
    expect(typeof claudeCodeProvider.captureSessionId).toBe('function');
  });
});
