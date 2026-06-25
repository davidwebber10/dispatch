import { describe, expect, test } from 'vitest';
import os from 'os';
import path from 'path';
import { darwin } from '../../src/platform/darwin.js';

describe('darwin platform', () => {
  test('defaultShell uses $SHELL or /bin/zsh', () => {
    const { command, args } = darwin.defaultShell();
    expect(command).toBe(process.env.SHELL || '/bin/zsh');
    expect(args).toEqual([]);
  });
  test('dataDir is ~/.dispatch', () => {
    expect(darwin.dataDir()).toBe(path.join(os.homedir(), '.dispatch'));
  });
  test('logDir is ~/Library/Logs/dispatch', () => {
    expect(darwin.logDir()).toBe(path.join(os.homedir(), 'Library', 'Logs', 'dispatch'));
  });
  test('claudeProjectDir encodes under ~/.claude/projects', () => {
    expect(darwin.claudeProjectDir('/tmp/proj')).toBe(
      path.join(os.homedir(), '.claude', 'projects', '-tmp-proj'),
    );
  });
  test('resolveCommand finds a real binary (sh) and returns null for nonsense', () => {
    expect(darwin.resolveCommand('sh')).toMatch(/sh$/);
    expect(darwin.resolveCommand('no-such-cmd-xyz')).toBeNull();
  });
  test('listProcessIds returns this process', () => {
    expect(darwin.listProcessIds()).toContain(process.pid);
  });
});
