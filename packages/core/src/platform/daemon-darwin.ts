import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { DaemonController, DaemonInstallOptions, DaemonStatus } from './daemon.js';

export type Runner = (cmd: string, args: string[]) => string;
const LABEL = 'com.dispatch.server';
const defaultRun: Runner = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8' });

export function createDarwinDaemon(run: Runner = defaultRun): DaemonController {
  const uid = process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  return {
    install(opts: DaemonInstallOptions) {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.mkdirSync(opts.logDir, { recursive: true });
      fs.writeFileSync(plistPath, buildPlist(opts));
      try { run('launchctl', ['bootstrap', domain, plistPath]); }
      catch { run('launchctl', ['load', '-w', plistPath]); }
    },
    uninstall() { try { run('launchctl', ['bootout', `${domain}/${LABEL}`]); } catch { /* ignore */ } },
    start() { run('launchctl', ['kickstart', `${domain}/${LABEL}`]); },
    stop() { run('launchctl', ['bootout', `${domain}/${LABEL}`]); },
    restart() { run('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]); },
    status(): DaemonStatus {
      try {
        const out = run('launchctl', ['list']);
        return { loaded: out.includes(LABEL) };
      } catch { return { loaded: false }; }
    },
  };
}

export function buildPlist(opts: DaemonInstallOptions): string {
  const envEntries = Object.entries(opts.env)
    .map(([k, v]) => `        <key>${k}</key>\n        <string>${v}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${opts.nodePath}</string>
        <string>${opts.entry}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${opts.repoRoot}</string>

    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ProcessType</key>
    <string>Interactive</string>

    <key>StandardOutPath</key>
    <string>${opts.logDir}/dispatch.out.log</string>

    <key>StandardErrorPath</key>
    <string>${opts.logDir}/dispatch.err.log</string>
</dict>
</plist>`;
}
