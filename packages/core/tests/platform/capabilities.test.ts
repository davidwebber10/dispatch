import { describe, test, expect } from 'vitest';
import { darwin } from '../../src/platform/darwin.js';
import { linux } from '../../src/platform/linux.js';

const local = { remoteAddress: '127.0.0.1', host: 'localhost:3456', proxied: false };
const proxied = { ...local, proxied: true };
const lan = { remoteAddress: '192.168.1.20', host: '192.168.1.5:3456', proxied: false };

describe('darwin capabilities', () => {
  test('file manager is Finder', () => expect(darwin.fileManagerName).toBe('Finder'));
  test('local loopback client accepted', () => expect(darwin.isLocalClient(local)).toBe(true));
  test('proxied and LAN clients refused', () => {
    expect(darwin.isLocalClient(proxied)).toBe(false);
    expect(darwin.isLocalClient(lan)).toBe(false);
  });
  test('tool key matches arch', () =>
    expect(darwin.toolPlatformKey()).toBe(process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'));
});

describe('linux capabilities', () => {
  test('headless: no file manager, reveal throws', async () => {
    expect(linux.fileManagerName).toBeNull();
    await expect(linux.revealInFileManager(['/tmp/x'])).rejects.toThrow(/not supported/i);
  });
  test('loopback rule holds', () => {
    expect(linux.isLocalClient(local)).toBe(true);
    expect(linux.isLocalClient(lan)).toBe(false);
  });
  test('tool key is linux-*', () => expect(linux.toolPlatformKey()).toMatch(/^linux-(x64|arm64)$/));

  test('defaultShell falls back to /bin/bash when SHELL is unset (no /bin/zsh on Ubuntu)', () => {
    const saved = process.env.SHELL;
    try {
      delete process.env.SHELL;
      expect(linux.defaultShell()).toEqual({ command: '/bin/bash', args: [] });
    } finally {
      if (saved === undefined) delete process.env.SHELL; else process.env.SHELL = saved;
    }
  });

  test('defaultShell honors SHELL when set', () => {
    const saved = process.env.SHELL;
    try {
      process.env.SHELL = '/usr/bin/fish';
      expect(linux.defaultShell()).toEqual({ command: '/usr/bin/fish', args: [] });
    } finally {
      if (saved === undefined) delete process.env.SHELL; else process.env.SHELL = saved;
    }
  });
});
