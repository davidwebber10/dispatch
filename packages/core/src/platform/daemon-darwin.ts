import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import type { DaemonController, DaemonInstallOptions, DaemonStatus } from './daemon.js';

export type Runner = (cmd: string, args: string[]) => string;
const LABEL = 'com.dispatch.server';
const defaultRun: Runner = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8' });

/**
 * Try a launchctl command against the gui/$uid domain first (interactive session),
 * then fall back to user/$uid (works over SSH / headless, where gui/ bootstrap fails
 * with EIO). Mirrors the old bash script's $DOMAIN / fallback pattern.
 */
function runWithDomainFallback(run: Runner, uid: number, verb: string[]): void {
  const guiDomain = `gui/${uid}`;
  const userDomain = `user/${uid}`;
  try {
    run('launchctl', [...verb.map(s => s.replace('__DOMAIN__', guiDomain))]);
  } catch {
    run('launchctl', [...verb.map(s => s.replace('__DOMAIN__', userDomain))]);
  }
}

export function createDarwinDaemon(run: Runner = defaultRun): DaemonController {
  const uid = process.getuid?.() ?? 0;
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

  // Over SSH the gui/ domain cannot be bootstrapped (EIO), so we pick the domain
  // from environment at construction time for install/unload helpers, but for all
  // lifecycle verbs we use runWithDomainFallback so they work in both cases.
  const primaryDomain = process.env.SSH_CONNECTION ? `user/${uid}` : `gui/${uid}`;

  return {
    install(opts: DaemonInstallOptions) {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.mkdirSync(opts.logDir, { recursive: true });
      fs.writeFileSync(plistPath, buildPlist(opts));
      try { run('launchctl', ['bootstrap', primaryDomain, plistPath]); }
      catch { run('launchctl', ['load', '-w', plistPath]); }
    },
    uninstall() {
      try { runWithDomainFallback(run, uid, ['bootout', `__DOMAIN__/${LABEL}`]); }
      catch { /* ignore — may already be unloaded */ }
    },
    start() { runWithDomainFallback(run, uid, ['kickstart', `__DOMAIN__/${LABEL}`]); },
    stop() { runWithDomainFallback(run, uid, ['bootout', `__DOMAIN__/${LABEL}`]); },
    restart() {
      // Restart must survive being called from inside a Dispatch-spawned terminal:
      // a synchronous kickstart -k would kill this process's PTY tree mid-execution.
      // Instead, spawn the kickstart detached and unref'd so it runs after our
      // process exits — mirroring the old bash `setsid / nohup` approach.
      const guiTarget = `gui/${uid}/${LABEL}`;
      const userTarget = `user/${uid}/${LABEL}`;
      const kickCmd =
        `launchctl kickstart -k ${guiTarget} 2>/dev/null || ` +
        `launchctl kickstart -k ${userTarget} 2>/dev/null`;
      const child = spawn(
        'sh', ['-c', `sleep 2; ${kickCmd}`],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
    },
    status(): DaemonStatus {
      try {
        const out = run('launchctl', ['list']);
        // Find the line whose 3rd column == LABEL (same as old bash agent_pid():
        //   launchctl list | awk -v l="$LABEL" '$3==l{print $1}')
        // Format: <pid-or-dash>  <exitcode>  <label>
        let loaded = false;
        let pid: number | undefined;
        for (const line of out.split('\n')) {
          const cols = line.trim().split(/\s+/);
          if (cols.length >= 3 && cols[2] === LABEL) {
            loaded = true;
            // First column is '-' when loaded-but-not-running, or an integer PID.
            const raw = cols[0];
            if (raw !== '-') {
              const n = parseInt(raw, 10);
              if (!isNaN(n)) pid = n;
            }
            break;
          }
        }
        return pid !== undefined ? { loaded, pid } : { loaded };
      } catch { return { loaded: false }; }
    },
  };
}

/** XML-escape a string for safe interpolation into plist content (matches old bash sed escaping). */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildPlist(opts: DaemonInstallOptions): string {
  const envEntries = Object.entries(opts.env)
    .map(([k, v]) => `        <key>${esc(k)}</key>\n        <string>${esc(v)}</string>`).join('\n');
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
