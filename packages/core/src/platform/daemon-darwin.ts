import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import type { DaemonController, DaemonInstallOptions, DaemonStatus } from './daemon.js';

export type RunnerOpts = { quiet?: boolean };
export type Runner = (cmd: string, args: string[], opts?: RunnerOpts) => string;
const LABEL = 'com.dispatch.server';
const defaultRun: Runner = (cmd, args, opts) =>
  execFileSync(cmd, args, opts?.quiet
    ? { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    : { encoding: 'utf-8' });

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

export function createDarwinDaemon(
  run: Runner = defaultRun,
  sleeper?: (ms: number) => void,
  plistOverride?: string,
): DaemonController {
  const uid = process.getuid?.() ?? 0;
  const plistPath = plistOverride ?? path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

  // Default sync sleeper uses Atomics.wait on a shared buffer — a true blocking
  // sleep without spinning, safe on the Node main thread.
  const sleep = sleeper ?? ((ms: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  });

  // Over SSH the gui/ domain cannot be bootstrapped (EIO), so we pick the domain
  // from environment at construction time for install/unload helpers, but for all
  // lifecycle verbs we use runWithDomainFallback so they work in both cases.
  const primaryDomain = process.env.SSH_CONNECTION ? `user/${uid}` : `gui/${uid}`;

  /** Check whether LABEL appears in `launchctl list` output. */
  function isLoaded(): boolean {
    try {
      const out = run('launchctl', ['list']);
      return out.split('\n').some(line => {
        const cols = line.trim().split(/\s+/);
        return cols.length >= 3 && cols[2] === LABEL;
      });
    } catch { return false; }
  }

  return {
    install(opts: DaemonInstallOptions) {
      // 1. Write plist and ensure directories.
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.mkdirSync(opts.logDir, { recursive: true });
      fs.writeFileSync(plistPath, buildPlist(opts));

      // 2. Bootout first (idempotency) — ignore all errors (may not be loaded).
      // quiet:true suppresses the expected "Boot-out failed: 3: No such process" stderr noise.
      try { run('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { quiet: true }); } catch { /* ignore */ }
      try { run('launchctl', ['bootout', `user/${uid}/${LABEL}`], { quiet: true }); } catch { /* ignore */ }

      // 3. Poll for teardown (up to ~5 × 500ms = 2.5s).
      for (let i = 0; i < 5; i++) {
        if (!isLoaded()) break;
        sleep(500);
      }

      // 4. Bootstrap with retry — try gui/ first, fall back to user/, retry up to 3 total.
      const domains = [`gui/${uid}`, `user/${uid}`];
      let bootstrapped = false;
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts && !bootstrapped; attempt++) {
        const domain = domains[attempt % domains.length] ?? domains[0];
        try {
          run('launchctl', ['bootstrap', domain!, plistPath]);
          bootstrapped = true;
        } catch {
          if (attempt < maxAttempts - 1) sleep(300);
        }
      }

      // 5. Verify loaded.
      if (!isLoaded()) {
        throw new Error(
          'dispatch: failed to load launchd agent after install — run: launchctl list | grep com.dispatch.server',
        );
      }
    },
    uninstall() {
      try { runWithDomainFallback(run, uid, ['bootout', `__DOMAIN__/${LABEL}`]); }
      catch { /* ignore — may already be unloaded */ }
      fs.rmSync(plistPath, { force: true });
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
