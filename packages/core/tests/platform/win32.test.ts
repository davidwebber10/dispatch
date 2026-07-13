import { describe, expect, test } from 'vitest';
import os from 'os';
import path from 'path';
import { win32 } from '../../src/platform/win32.js';

describe('win32 platform (logic)', () => {
  test('resolveLoginPath is undefined (Task Scheduler inherits registry PATH)', () => {
    expect(win32.resolveLoginPath()).toBeUndefined();
  });
  test('dataDir is ~/.dispatch via os.homedir()', () => {
    expect(win32.dataDir()).toBe(path.join(os.homedir(), '.dispatch'));
  });
  test('claudeProjectDir uses the win32 encoding', () => {
    expect(win32.claudeProjectDir('C:\\Users\\x\\proj'))
      .toBe(path.join(os.homedir(), '.claude', 'projects', 'C--Users-x-proj'));
  });
  test('installBrowserShim is a no-op returning {}', () => {
    expect(win32.installBrowserShim({ dataDir: 'x', serverUrl: 'y' })).toEqual({});
  });
  test('defaultShell prefers pwsh, falls back to powershell.exe', () => {
    const withPwsh = win32.defaultShell((name) => (name === 'pwsh' ? 'C:\\pwsh.exe' : null));
    expect(withPwsh).toEqual({ command: 'C:\\pwsh.exe', args: ['-NoLogo'] });
    const noPwsh = win32.defaultShell(() => null);
    expect(noPwsh).toEqual({ command: 'powershell.exe', args: ['-NoLogo'] });
  });
});
