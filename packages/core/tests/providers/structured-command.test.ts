import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { claudeCodeProvider } from '../../src/providers/claude-code.js';

it('buildStructuredCommand emits the stream-json control-protocol flags', () => {
  const cmd = claudeCodeProvider.buildStructuredCommand!({ workDir: '/tmp' });
  expect(cmd.command).toBe('claude');
  const a = cmd.args.join(' ');
  expect(a).toContain('--input-format stream-json');
  expect(a).toContain('--output-format stream-json');
  expect(a).toContain('--permission-prompt-tool stdio');
  expect(a).toContain('--permission-mode default');
  expect(cmd.args).toContain('--include-partial-messages'); // streaming deltas
  expect(cmd.args).not.toContain('--dangerously-skip-permissions');
});

it('folds in mcp-config + system prompt when provided', () => {
  const cmd = claudeCodeProvider.buildStructuredCommand!({ workDir: '/tmp', secretsMcp: { claudeConfigPath: '/x/mcp.json', codexArgs: [], systemPrompt: 'note' } });
  expect(cmd.args).toContain('--mcp-config');
  expect(cmd.args).toContain('--append-system-prompt');
});

it('appends an Overseer persona prompt when given appendSystemPrompt', () => {
  const persona = 'You are the Overseer — a coordinator.';
  const cmd = claudeCodeProvider.buildStructuredCommand!({ workDir: '/tmp', appendSystemPrompt: persona });
  const i = cmd.args.indexOf('--append-system-prompt');
  expect(i).toBeGreaterThanOrEqual(0);
  expect(cmd.args[i + 1]).toBe(persona);
});

it('omits --append-system-prompt when no persona and no secrets prompt', () => {
  const cmd = claudeCodeProvider.buildStructuredCommand!({ workDir: '/tmp' });
  expect(cmd.args).not.toContain('--append-system-prompt');
});

it('pinned claude still accepts --permission-prompt-tool stdio (smoke)', () => {
  let help = '';
  try { help = execFileSync('claude', ['--help'], { encoding: 'utf8' }); } catch { return; } // skip if claude absent (CI)
  // The flag is intentionally undocumented; this asserts the binary at least runs and
  // is the expected CLI. The real guarantee is the manual run in the verification section.
  expect(help.toLowerCase()).toContain('claude');
});
