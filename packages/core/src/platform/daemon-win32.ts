import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { DaemonController, DaemonInstallOptions, DaemonStatus } from './daemon.js';
import { buildLogonTaskXml } from './win32-task-xml.js';

export type Runner = (cmd: string, args: string[]) => string;
const TASK = 'Dispatch';
const defaultRun: Runner = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8' });
const defaultUser = () => `${process.env.USERDOMAIN ?? os.hostname()}\\${process.env.USERNAME ?? os.userInfo().username}`;

export function createWin32Daemon(run: Runner = defaultRun, userId: () => string = defaultUser): DaemonController {
  return {
    install(opts: DaemonInstallOptions) {
      fs.mkdirSync(opts.logDir, { recursive: true });
      const xml = buildLogonTaskXml({ ...opts, userId: userId() });
      const xmlPath = path.join(opts.logDir, 'dispatch-task.xml');
      fs.writeFileSync(xmlPath, '﻿' + xml, { encoding: 'utf16le' });
      run('schtasks', ['/Create', '/TN', TASK, '/XML', xmlPath, '/F']);
      run('schtasks', ['/Run', '/TN', TASK]);
    },
    uninstall() { run('schtasks', ['/Delete', '/TN', TASK, '/F']); },
    start() { run('schtasks', ['/Run', '/TN', TASK]); },
    stop() { run('schtasks', ['/End', '/TN', TASK]); },
    restart() { try { run('schtasks', ['/End', '/TN', TASK]); } catch { /* ignore */ } run('schtasks', ['/Run', '/TN', TASK]); },
    status(): DaemonStatus {
      try {
        const out = run('schtasks', ['/Query', '/TN', TASK]);
        return { loaded: /Running|Ready/i.test(out) };
      } catch {
        return { loaded: false };
      }
    },
  };
}
