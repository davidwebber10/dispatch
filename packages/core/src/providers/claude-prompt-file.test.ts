import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseClaudeVersion, supportsPromptFile, appendSystemPromptArgs, writePromptFile, prunePromptFiles,
  warmClaudeVersion, claudePromptFileSupported, resetClaudeVersionForTests, setClaudeProbeEnv,
} from './claude-prompt-file.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-file-')); resetClaudeVersionForTests(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); resetClaudeVersionForTests(); });

describe('the Claude Code version gate', () => {
  it('reads the version from `claude --version`', () => {
    expect(parseClaudeVersion('2.1.296 (Claude Code)\n')).toEqual([2, 1, 296]);
    expect(parseClaudeVersion('1.0.55')).toEqual([1, 0, 55]);
    expect(parseClaudeVersion('not a version')).toBeNull();
  });

  // CHANGELOG 2.1.69: the -file forms work in interactive mode too (CLI threads), not only -p.
  it('the file form needs 2.1.69 or newer', () => {
    expect(supportsPromptFile([2, 1, 68])).toBe(false);
    expect(supportsPromptFile([2, 1, 69])).toBe(true);
    expect(supportsPromptFile([2, 2, 0])).toBe(true);
    expect(supportsPromptFile([3, 0, 0])).toBe(true);
    expect(supportsPromptFile([2, 0, 99])).toBe(false);
    expect(supportsPromptFile([1, 9, 999])).toBe(false);
  });

  it('is off until the version is known, and follows it once read', async () => {
    expect(claudePromptFileSupported()).toBe(false);
    await warmClaudeVersion(async () => '2.1.296 (Claude Code)');
    expect(claudePromptFileSupported()).toBe(true);
    await warmClaudeVersion(async () => '2.1.10 (Claude Code)');
    expect(claudePromptFileSupported()).toBe(false);
  });

  // Review: agents run the `claude` first on THEIR PATH (Dispatch's bin dirs come first), so the
  // version must be read from that same binary, not from the daemon's own PATH.
  it('reads the version of the claude on the agents\' PATH', async () => {
    const mk = (name: string, version: string) => {
      const bin = path.join(dir, name);
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
      return bin;
    };
    const oldBin = mk('old', '2.1.10');
    const newBin = mk('new', '2.1.300');
    setClaudeProbeEnv({ ...process.env, PATH: `${oldBin}:${process.env.PATH}` } as Record<string, string>);
    await warmClaudeVersion();
    expect(claudePromptFileSupported()).toBe(false);
    setClaudeProbeEnv({ ...process.env, PATH: `${newBin}:${process.env.PATH}` } as Record<string, string>);
    await warmClaudeVersion();
    expect(claudePromptFileSupported()).toBe(true);
  });

  // The spawn env is an OVERLAY that the thread managers spread over the daemon's env. Run alone,
  // the CLI got no USER/HOME (v3.1.5's sign-in check said "signed out" for exactly this reason).
  it('keeps the daemon\'s own env under the spawn env overlay', async () => {
    const bin = path.join(dir, 'user-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n[ -n "$USER" ] && echo "2.1.300 (Claude Code)"\n', { mode: 0o755 });
    const prevUser = process.env.USER;
    process.env.USER = 'someone';
    try {
      setClaudeProbeEnv({ PATH: `${bin}:/usr/bin:/bin` });
      await warmClaudeVersion();
      expect(claudePromptFileSupported()).toBe(true);
    } finally {
      process.env.USER = prevUser;
    }
  });

  it('a failed version read means the text form', async () => {
    await warmClaudeVersion(async () => { throw new Error('ENOENT'); });
    expect(claudePromptFileSupported()).toBe(false);
  });
});

describe('the prompt file', () => {
  it('holds the text, is private, and the same text maps to the same file', () => {
    const a = writePromptFile(dir, 'You are thread A.');
    const b = writePromptFile(dir, 'You are thread A.');
    const c = writePromptFile(dir, 'You are thread B.');
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(fs.readFileSync(a, 'utf8')).toBe('You are thread A.');
    expect(fs.statSync(a).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('prunes files not used for a week, and keeps recent ones', () => {
    const old = writePromptFile(dir, 'old');
    const recent = writePromptFile(dir, 'recent');
    const weekAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(old, weekAgo, weekAgo);
    prunePromptFiles(dir);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('reusing a file marks it as used, so pruning keeps it', () => {
    const f = writePromptFile(dir, 'reused');
    const weekAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(f, weekAgo, weekAgo);
    writePromptFile(dir, 'reused');
    prunePromptFiles(dir);
    expect(fs.existsSync(f)).toBe(true);
  });
});

describe('appendSystemPromptArgs', () => {
  it('with the file form: one file holding every part, in order, and no prompt text in argv', () => {
    const args = appendSystemPromptArgs(['Secrets note.', undefined, 'Persona.'], { dir, supported: true });
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('--append-system-prompt-file');
    expect(fs.readFileSync(args[1], 'utf8')).toBe('Secrets note.\n\nPersona.');
    expect(args.join(' ')).not.toContain('Persona.');
  });

  it('without it: the text flags, one per part (unchanged behavior)', () => {
    expect(appendSystemPromptArgs(['Secrets note.', null, 'Persona.'], { dir, supported: false }))
      .toEqual(['--append-system-prompt', 'Secrets note.', '--append-system-prompt', 'Persona.']);
  });

  it('nothing to append: no args, no file', () => {
    expect(appendSystemPromptArgs([undefined, '  ', null], { dir, supported: true })).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('falls back to the text flags when the file cannot be written', () => {
    const blocked = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocked, 'x');
    expect(appendSystemPromptArgs(['Persona.'], { dir: blocked, supported: true })).toEqual(['--append-system-prompt', 'Persona.']);
  });
});
