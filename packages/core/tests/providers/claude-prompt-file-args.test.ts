// The Claude provider hands the appended system prompt over as ONE private file once the installed
// Claude Code is known to support it (2.1.69+), and as text flags otherwise (unchanged). With the
// file form, no prompt text is in argv: a broad `pkill -f <word>` cannot match it, and `ps` and
// process logs do not show it.
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { claudeCodeProvider } from '../../src/providers/claude-code.js';
import { warmClaudeVersion, resetClaudeVersionForTests } from '../../src/providers/claude-prompt-file.js';

const secretsMcp = { claudeConfigPath: '/x/mcp.json', codexArgs: [], systemPrompt: 'Secrets and roster note.' };
const fileOf = (args: string[]) => { const i = args.indexOf('--append-system-prompt-file'); return i < 0 ? null : args[i + 1]; };

beforeEach(async () => { resetClaudeVersionForTests(); await warmClaudeVersion(async () => '2.1.296 (Claude Code)'); });
afterEach(() => resetClaudeVersionForTests());

it('structured: the secrets note and the persona go into one file, in that order, and not into argv', () => {
  const cmd = claudeCodeProvider.buildStructuredCommand!({ workDir: '/tmp', secretsMcp, appendSystemPrompt: 'You are the Overseer.' });
  expect(cmd.args).not.toContain('--append-system-prompt');
  const file = fileOf(cmd.args);
  expect(file).not.toBeNull();
  expect(fs.readFileSync(file!, 'utf8')).toBe('Secrets and roster note.\n\nYou are the Overseer.');
  expect(cmd.args.join(' ')).not.toContain('Overseer');
});

it('CLI new, resume and branch commands use the file too', () => {
  for (const cmd of [
    claudeCodeProvider.buildNewCommand({ workDir: '/tmp', secretsMcp }),
    claudeCodeProvider.buildResumeCommand({ externalSessionId: 'sid', workDir: '/tmp', secretsMcp }),
    claudeCodeProvider.buildBranchCommand!({ sourceSessionId: 'sid', workDir: '/tmp', secretsMcp }),
  ]) {
    expect(cmd.args).not.toContain('--append-system-prompt');
    expect(fs.readFileSync(fileOf(cmd.args)!, 'utf8')).toBe('Secrets and roster note.');
  }
});

it('an older Claude keeps the text flags', async () => {
  resetClaudeVersionForTests();
  await warmClaudeVersion(async () => '2.1.60 (Claude Code)');
  const cmd = claudeCodeProvider.buildStructuredCommand!({ workDir: '/tmp', secretsMcp, appendSystemPrompt: 'You are the Overseer.' });
  expect(fileOf(cmd.args)).toBeNull();
  expect(cmd.args.filter((a) => a === '--append-system-prompt')).toHaveLength(2);
});
