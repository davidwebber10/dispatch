import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureClaudeTranscriptRetention } from './claude-retention.js';

let dir: string;
const file = () => path.join(dir, 'settings.json');
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-retention-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('ensureClaudeTranscriptRetention', () => {
  it('adds cleanupPeriodDays 3650 and keeps every other key', () => {
    fs.writeFileSync(file(), JSON.stringify({ env: { MCP_TIMEOUT: '30000' }, model: 'opus', permissions: { allow: ['Bash(ls)'] } }));
    expect(ensureClaudeTranscriptRetention(dir)).toBe('added');
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ env: { MCP_TIMEOUT: '30000' }, model: 'opus', permissions: { allow: ['Bash(ls)'] }, cleanupPeriodDays: 3650 });
    expect(fs.readdirSync(dir)).toEqual(['settings.json']); // no temp file left
  });
  it('never overwrites a value the person set, whatever it is', () => {
    for (const v of [30, 7, 100000, 0]) {
      fs.writeFileSync(file(), JSON.stringify({ cleanupPeriodDays: v }));
      expect(ensureClaudeTranscriptRetention(dir)).toBe('kept');
      expect(JSON.parse(fs.readFileSync(file(), 'utf8')).cleanupPeriodDays).toBe(v);
    }
  });
  it('creates the file when the folder exists but the file does not; an empty file counts as empty', () => {
    expect(ensureClaudeTranscriptRetention(dir)).toBe('created');
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ cleanupPeriodDays: 3650 });
    fs.writeFileSync(file(), '  \n');
    expect(ensureClaudeTranscriptRetention(dir)).toBe('added');
  });
  it('does nothing when there is no Claude folder', () => {
    const gone = path.join(dir, 'nope');
    expect(ensureClaudeTranscriptRetention(gone)).toBe('no-claude-dir');
    expect(fs.existsSync(gone)).toBe(false);
  });
  it('does not touch an invalid or non-object file', () => {
    for (const raw of ['{ not json', '[1,2]', '"x"', 'null']) {
      fs.writeFileSync(file(), raw);
      expect(ensureClaudeTranscriptRetention(dir)).toBe('invalid-file');
      expect(fs.readFileSync(file(), 'utf8')).toBe(raw);
    }
  });
  it('writes through a symlinked settings.json and keeps the link, and keeps the file mode', () => {
    const primary = path.join(dir, 'primary');
    const account = path.join(dir, 'account');
    fs.mkdirSync(primary); fs.mkdirSync(account);
    fs.writeFileSync(path.join(primary, 'settings.json'), '{"a":1}', { mode: 0o640 });
    fs.symlinkSync(path.join(primary, 'settings.json'), path.join(account, 'settings.json'));
    expect(ensureClaudeTranscriptRetention(account)).toBe('added');
    expect(fs.lstatSync(path.join(account, 'settings.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(primary, 'settings.json'), 'utf8'))).toEqual({ a: 1, cleanupPeriodDays: 3650 });
    expect(fs.statSync(path.join(primary, 'settings.json')).mode & 0o777).toBe(0o640);
  });
  it('a second run changes nothing', () => {
    fs.writeFileSync(file(), '{}');
    ensureClaudeTranscriptRetention(dir);
    const once = fs.readFileSync(file(), 'utf8');
    expect(ensureClaudeTranscriptRetention(dir)).toBe('kept');
    expect(fs.readFileSync(file(), 'utf8')).toBe(once);
  });
});
