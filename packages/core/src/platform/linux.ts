import os from 'os';
import path from 'path';
import { darwin } from './darwin.js';
import type { Platform } from './types.js';
import type { DaemonController } from './daemon.js';

// Linux reuses the posix runtime behaviour from darwin. Full Linux daemon
// support is out of scope; the daemon throws clearly if used. This exists so
// Linux CI and dev environments can load the platform layer and run the suite.
const linuxDaemonUnsupported: DaemonController = {
  install() { throw new Error('Dispatch daemon management is not implemented on Linux yet.'); },
  uninstall() { throw new Error('Dispatch daemon management is not implemented on Linux yet.'); },
  start() { throw new Error('Dispatch daemon management is not implemented on Linux yet.'); },
  stop() { throw new Error('Dispatch daemon management is not implemented on Linux yet.'); },
  restart() { throw new Error('Dispatch daemon management is not implemented on Linux yet.'); },
  status() { return { loaded: false }; },
};

export const linux: Platform = {
  ...darwin,
  id: 'linux',
  flavor: 'linux',
  fileManagerName: null,
  // isLocalClient inherits darwin's loopback rule via the spread — correct for both.
  revealInFileManager: async () => { throw new Error('Reveal is not supported on headless Linux.'); },
  toolPlatformKey: () => (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64'),
  tailscaleStatus: async () => ({ ip: null, hostname: null, online: false }),
  logDir: () => path.join(os.homedir(), '.dispatch', 'logs'),
  daemon: linuxDaemonUnsupported,
};
