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

  it('structured transport speaks ACP over `grok agent stdio`, auto-approving', () => {
    const cmd = grokProvider.buildStructuredCommand!({ workDir: '/tmp' });
    expect(cmd.command).toBe('grok');
    expect(cmd.args).toEqual(['agent', '--always-approve', 'stdio']);
  });

  it('structured transport carries the MCP plugin via --plugin-dir on the agent subcommand', () => {
    // --plugin-dir is the TRUSTED plugin scope: a GROK_HOME plugin loads untrusted and its
    // MCP tools end up hidden from the model (verified live — the thread could see the
    // dispatch server but not call report_status until the plugin came in via --plugin-dir).
    const cmd = grokProvider.buildStructuredCommand!({ workDir: '/tmp', grokPluginDir: '/x/plugins/dispatch' });
    const i = cmd.args.indexOf('--plugin-dir');
    expect(i).toBeGreaterThan(cmd.args.indexOf('agent')); // subcommand-scoped flag
    expect(cmd.args[i + 1]).toBe('/x/plugins/dispatch');
    expect(cmd.args.indexOf('stdio')).toBeGreaterThan(i);
  });

  it('structured transport pins the model and carries rules BEFORE the agent subcommand', () => {
    const cmd = grokProvider.buildStructuredCommand!({ workDir: '/tmp', model: 'grok-4.6', appendSystemPrompt: 'be brief', secretsMcp: { systemPrompt: 'use Doppler' } });
    // Top-level flags must precede `agent` (clap rejects them after the subcommand).
    expect(cmd.args.indexOf('--rules')).toBeLessThan(cmd.args.indexOf('agent'));
    expect(cmd.args.indexOf('--model')).toBeLessThan(cmd.args.indexOf('agent'));
    expect(cmd.args).toContain('grok-4.6');
    expect(cmd.args[cmd.args.indexOf('--rules') + 1]).toBe('be brief\n\nuse Doppler');
  });

  it('structured resume rides out-of-band (session/load), never argv', () => {
    const cmd = grokProvider.buildStructuredCommand!({ workDir: '/tmp', resumeSessionId: 'abc-123' });
    expect(cmd.args).not.toContain('abc-123');
    expect(cmd.args).not.toContain('--resume');
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

describe('grok reports status through hooks', () => {
  it('uses the hooks strategy, not pty timing', () => {
    // Grok's binary carries Claude Code's whole hook vocabulary (Stop, PreToolUse,
    // PostToolUse, SubagentStop, Idle, SessionStart, SessionEnd, Notification,
    // UserPromptSubmit, PreCompact) — so it can report turn-complete properly.
    expect(grokProvider.statusStrategy).toBe('hooks');
    expect(typeof grokProvider.buildStatusHooks).toBe('function');
  });

  it('points its hooks at the grok events route', () => {
    const plan = grokProvider.buildStatusHooks!({
      serverUrl: 'http://127.0.0.1:3456', terminalId: 't1',
      codexHelperPath: '/opt/codex.mjs', grokHelperPath: '/opt/grok.mjs',
    });
    expect(plan?.grokHooks?.eventsUrl).toBe('http://127.0.0.1:3456/api/events/grok/t1');
    expect(plan?.grokHooks?.helperPath).toBe('/opt/grok.mjs');
  });

  it('opts out when no helper script was supplied, rather than emitting a broken hook', () => {
    const plan = grokProvider.buildStatusHooks!({
      serverUrl: 'http://127.0.0.1:3456', terminalId: 't1', codexHelperPath: '/opt/codex.mjs',
    });
    expect(plan).toBeUndefined();
  });

  it('NEVER passes --plugin-dir, which the top-level command rejects outright', () => {
    // The regression: --plugin-dir exists only on the `grok agent` subcommand. On the
    // top-level command it is a hard startup error —
    //   error: unexpected argument '--plugin-dir' found
    // — so every Grok thread failed to launch. Hooks and MCP go through GROK_HOME instead.
    const cmds = [
      grokProvider.buildNewCommand({ workDir: '/tmp', statusHooks: { grokHomeDir: '/data/homes/t1' } }),
      grokProvider.buildResumeCommand({ externalSessionId: 'abc', workDir: '/tmp', statusHooks: { grokHomeDir: '/data/homes/t1' } }),
      grokProvider.buildRunnerCommand({ workDir: '/tmp', prompt: 'go' }),
    ];
    for (const c of cmds) expect(c.args).not.toContain('--plugin-dir');
  });

  it('passes only flags the top-level command actually accepts', () => {
    // Every flag Grok 1.0.3's `grok --help` lists. A flag that is real on a SUBCOMMAND but
    // not here is a startup error, which is exactly how --plugin-dir got shipped.
    const TOP_LEVEL = new Set([
      '--permission-mode', '--model', '-m', '--rules', '--session-id', '-s', '--resume', '-r',
      '--single', '-p', '--always-approve', '--continue', '-c', '--cwd', '--output-format',
      '--fork-session', '--no-plan', '--max-turns', '--reasoning-effort', '--worktree', '-w',
    ]);
    const cmds = [
      grokProvider.buildNewCommand({ workDir: '/tmp', sessionId: 'x', model: 'grok-4.5', secretsMcp: { systemPrompt: 'p' }, statusHooks: { grokHomeDir: '/h' } }),
      grokProvider.buildResumeCommand({ externalSessionId: 'abc', workDir: '/tmp', model: 'grok-4.5', secretsMcp: { systemPrompt: 'p' }, statusHooks: { grokHomeDir: '/h' } }),
      grokProvider.buildRunnerCommand({ workDir: '/tmp', prompt: 'go' }),
    ];
    for (const c of cmds) {
      for (const a of c.args) {
        if (a.startsWith('-')) expect(TOP_LEVEL.has(a), `"${a}" is not a top-level grok flag`).toBe(true);
      }
    }
  });
});

describe('grok is told about its tools, not just given them', () => {
  const prompt = 'Use Doppler for secrets. You have peer tools.';

  it('appends the system prompt with --rules on a new thread', () => {
    // Registering an MCP server hands the agent the tools; the system prompt is how it
    // learns to reach for them. Claude uses --append-system-prompt, Codex a developer
    // instruction; Grok documents --rules as "extra rules to append to the system prompt".
    const cmd = grokProvider.buildNewCommand({ workDir: '/tmp', secretsMcp: { systemPrompt: prompt } });
    const i = cmd.args.indexOf('--rules');
    expect(i).toBeGreaterThan(-1);
    expect(cmd.args[i + 1]).toBe(prompt);
  });

  it('appends it on a resume too — a resumed thread must know the same things', () => {
    const cmd = grokProvider.buildResumeCommand({
      externalSessionId: 'abc', workDir: '/tmp', secretsMcp: { systemPrompt: prompt },
    });
    expect(cmd.args).toContain('--rules');
    expect(cmd.args.indexOf('--rules')).toBeLessThan(cmd.args.indexOf('--resume'));
  });

  it('omits --rules when there is nothing to say', () => {
    expect(grokProvider.buildNewCommand({ workDir: '/tmp' }).args).not.toContain('--rules');
    expect(grokProvider.buildNewCommand({ workDir: '/tmp', secretsMcp: {} }).args).not.toContain('--rules');
  });

  it('keeps the prompt ahead of the positional prompt argument', () => {
    const cmd = grokProvider.buildNewCommand({ workDir: '/tmp', secretsMcp: { systemPrompt: prompt }, prompt: 'do it' });
    expect(cmd.args[cmd.args.length - 1]).toBe('do it');
    expect(cmd.args.indexOf('--rules')).toBeLessThan(cmd.args.length - 1);
  });
});
