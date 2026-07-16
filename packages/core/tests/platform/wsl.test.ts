import { describe, test, expect } from 'vitest';
import { detectWsl, createWslPlatform, parseDefaultGateway } from '../../src/platform/wsl.js';

describe('detectWsl', () => {
  test('true when WSL_DISTRO_NAME is set', () => {
    expect(detectWsl({ WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv, () => '')).toBe(true);
  });
  test('true when /proc/version mentions microsoft', () => {
    expect(detectWsl({} as NodeJS.ProcessEnv, () => 'Linux version 5.15.153.1-microsoft-standard-WSL2')).toBe(true);
  });
  test('false on plain linux', () => {
    expect(detectWsl({} as NodeJS.ProcessEnv, () => 'Linux version 6.8.0-generic')).toBe(false);
  });
  test('false when /proc/version is unreadable', () => {
    expect(detectWsl({} as NodeJS.ProcessEnv, () => { throw new Error('ENOENT'); })).toBe(false);
  });
});

describe('wsl platform', () => {
  test('is linux with flavor wsl', () => {
    const p = createWslPlatform();
    expect(p.id).toBe('linux');
    expect(p.logDir()).toContain('.dispatch');
  });
});

const ROUTE = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0120A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t0020A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0`;

test('parseDefaultGateway decodes little-endian hex', () => {
  expect(parseDefaultGateway(ROUTE)).toBe('192.168.32.1');
});
test('parseDefaultGateway null when no default route', () => {
  expect(parseDefaultGateway(ROUTE.split('\n').filter((l) => !l.includes('00000000\t0120A8C0')).join('\n'))).toBeNull();
});

function fakeWsl(calls: string[][], gw = ROUTE) {
  return createWslPlatform({
    execFile: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'wslpath') return { stdout: 'C:\\Users\\dw\\proj\\file.txt\n' };
      return { stdout: '' };
    },
    // Throws for unknown paths (matches real fs.readFileSync ENOENT behavior); only
    // /proc/net/route and the binfmt interop marker resolve.
    readFileSync: (p) => {
      if (p === '/proc/net/route') return gw;
      if (p === '/proc/sys/fs/binfmt_misc/WSLInterop') return 'enabled\ninterpreter /init\n';
      throw new Error('ENOENT');
    },
    env: { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/1_interop' } as NodeJS.ProcessEnv,
  });
}

test('reveal translates via wslpath and invokes explorer.exe /select', async () => {
  const calls: string[][] = [];
  await fakeWsl(calls).revealInFileManager(['/home/dw/proj/file.txt']);
  expect(calls).toEqual([
    ['wslpath', '-w', '/home/dw/proj/file.txt'],
    ['explorer.exe', '/select,C:\\Users\\dw\\proj\\file.txt'],
  ]);
});
test('explorer.exe nonzero exit is swallowed (it exits 1 on success)', async () => {
  const p = createWslPlatform({
    execFile: async (cmd, args) => {
      if (cmd === 'explorer.exe') { const e: any = new Error('exit 1'); e.code = 1; throw e; }
      return { stdout: 'C:\\x\n' };
    },
    readFileSync: () => ROUTE, env: {} as NodeJS.ProcessEnv,
  });
  await expect(p.revealInFileManager(['/x'])).resolves.toBeUndefined();
});
test('isLocalClient: NAT gateway peer with localhost Host accepted; portproxy LAN refused; tunnel refused', () => {
  const p = fakeWsl([]);
  expect(p.isLocalClient({ remoteAddress: '192.168.32.1', host: 'localhost:3456', proxied: false })).toBe(true);
  expect(p.isLocalClient({ remoteAddress: '127.0.0.1', host: 'localhost:3456', proxied: false })).toBe(true);   // mirrored mode
  expect(p.isLocalClient({ remoteAddress: '192.168.32.1', host: '192.168.1.5:3456', proxied: false })).toBe(false); // portproxy
  expect(p.isLocalClient({ remoteAddress: '192.168.32.1', host: 'localhost:3456', proxied: true })).toBe(false);    // tunnel
});
test('fileManagerName is File Explorer', () => expect(fakeWsl([]).fileManagerName).toBe('File Explorer'));

describe('interop probe (fileManagerName)', () => {
  test('no interop available (binfmt read throws, WSL_INTEROP unset) → fileManagerName is null', () => {
    const p = createWslPlatform({
      execFile: async () => ({ stdout: '' }),
      readFileSync: () => { throw new Error('ENOENT'); },
      env: { WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv,
    });
    expect(p.fileManagerName).toBeNull();
  });

  test('WSL_INTEROP env fallback when binfmt read throws → File Explorer', () => {
    const p = createWslPlatform({
      execFile: async () => ({ stdout: '' }),
      readFileSync: () => { throw new Error('ENOENT'); },
      env: { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/1_interop' } as NodeJS.ProcessEnv,
    });
    expect(p.fileManagerName).toBe('File Explorer');
  });

  test('probe is cached: readFileSync for the binfmt path is called once across two reads', () => {
    let binfmtReads = 0;
    const p = createWslPlatform({
      execFile: async () => ({ stdout: '' }),
      readFileSync: (path) => {
        if (path === '/proc/sys/fs/binfmt_misc/WSLInterop') { binfmtReads++; return 'enabled\n'; }
        throw new Error('ENOENT');
      },
      env: { WSL_DISTRO_NAME: 'Ubuntu' } as NodeJS.ProcessEnv,
    });
    expect(p.fileManagerName).toBe('File Explorer');
    expect(p.fileManagerName).toBe('File Explorer');
    expect(binfmtReads).toBe(1);
  });
});
