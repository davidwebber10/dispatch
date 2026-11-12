// packages/core/src/privsep/selfcheck.ts
// The start-up self-check (design sections 3 D12 and 10). It runs one small shell script AS THE AGENT
// USER (through the spawn guard, like every child) and asks it to do what a workload must not be
// able to do. The image reports `privsep-v1` only when every attempt failed. The check proves on
// the real platform what the design assumes about it.
//
// `userns`: a workload must not be able to make a user namespace. In one of its own it can mount an
// empty folder over /etc/claude-code, and a nested harness then sees no managed policy at all (no
// approval lock, no MCP allow-list, no connector or Artifact switch). The sysctl
// `user.max_user_namespaces` cannot be set on Fargate; the runtime's default seccomp filter normally
// refuses `unshare`/`clone(CLONE_NEWUSER)` to a process without CAP_SYS_ADMIN. This check MEASURES that
// on each start: when the namespace can be made, the box does not report privsep-v1.
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { PrivsepConfig } from './config.js';

export interface SelfCheckResult {
  ok: boolean;
  /** One entry per attempt that did NOT fail as it should. Empty when ok. */
  failures: string[];
  /** Every line the script printed, for the box log. */
  lines: string[];
}

/**
 * The script. Each line of output is `PASS name` or `FAIL name detail`. It uses only a POSIX shell
 * and the tools of the base image. `$1` the daemon's pid, `$2` the state root, `$3` its parent,
 * `$4` the agent run dir, `$5` the agent uid.
 */
export const SELF_CHECK_SCRIPT = String.raw`
d="$1"; state="$2"; gate="$3"; run="$4"; want="$5"
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1 $2"; }
[ "$(id -u)" = "$want" ] && ok uid || bad uid "$(id -u)"
[ -z "$(id -G | tr ' ' '\n' | grep -x 0)" ] && ok no-root-group || bad no-root-group "$(id -G)"
s=/proc/self/status
[ "$(sed -n 's/^NoNewPrivs:[[:space:]]*//p' $s)" = 1 ] && ok no-new-privs || bad no-new-privs "$(sed -n 's/^NoNewPrivs:[[:space:]]*//p' $s)"
for c in CapPrm CapEff CapAmb CapInh; do
  v="$(sed -n "s/^$c:[[:space:]]*//p" $s)"
  [ "$v" = 0000000000000000 ] && ok "$c-empty" || bad "$c-empty" "$v"
done
if cat "/proc/$d/environ" >/dev/null 2>&1; then bad daemon-environ readable; else ok daemon-environ; fi
if cat /proc/1/environ >/dev/null 2>&1; then bad init-environ readable; else ok init-environ; fi
if ls "/proc/$d/fd" >/dev/null 2>&1; then bad daemon-fds listable; else ok daemon-fds; fi
if ls "/proc/$d/cwd/" >/dev/null 2>&1; then bad daemon-cwd reachable; else ok daemon-cwd; fi
if head -c 1 "/proc/$d/mem" >/dev/null 2>&1; then bad daemon-mem readable; else ok daemon-mem; fi
if kill -0 "$d" 2>/dev/null; then bad signal-daemon allowed; else ok signal-daemon; fi
if ls "$gate" >/dev/null 2>&1; then bad state-parent listable; else ok state-parent; fi
if ls "$state" >/dev/null 2>&1; then bad state-root listable; else ok state-root; fi
if cat "$state/dispatch.db" >/dev/null 2>&1; then bad state-db readable; else ok state-db; fi
if ( : > "$state/.probe" ) 2>/dev/null; then bad state-write allowed; rm -f "$state/.probe"; else ok state-write; fi
if ( : > "$run/.probe" ) 2>/dev/null; then bad run-dir-write allowed; rm -f "$run/.probe"; else ok run-dir-write; fi
if [ -r "$run" ]; then ok run-dir-read; else bad run-dir-read denied; fi
leak=""
for n in DISPATCH_BOX_TOKEN OS_BOX_TOKEN DISPATCH_SECRETS_FD AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI ECS_CONTAINER_METADATA_URI_V4 ECS_CONTAINER_METADATA_URI; do
  eval "v=\${$n:-}"; [ -n "$v" ] && leak="$leak $n"
done
[ -z "$leak" ] && ok env-clean || bad env-clean "$leak"
for f in /proc/[0-9]*/environ; do
  if [ -r "$f" ] && tr '\0' '\n' < "$f" 2>/dev/null | grep -qE '^(DISPATCH_BOX_TOKEN|OS_BOX_TOKEN)='; then bad proc-environ-token "$f"; fi
done
ok proc-environ-scan
if command -v su >/dev/null 2>&1 && su -s /bin/sh -c 'id -u' root </dev/null 2>/dev/null | grep -qx 0; then bad setuid-su works; else ok setuid-su; fi
if ! command -v unshare >/dev/null 2>&1; then bad userns "no unshare program: not measured"
elif unshare -Ur true >/dev/null 2>&1; then bad userns "a user namespace can be created"
else ok userns; fi
`;

export interface SelfCheckDeps {
  run?: (script: string, args: string[]) => Promise<string>;
  pid?: number;
}

const runAsWorkload = (script: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    // No uid here: the spawn guard gives every child the agent's identity. If the guard were not
    // installed the script would run as root and its first line would fail.
    execFile('/bin/sh', ['-c', script, 'selfcheck', ...args], { timeout: 20_000, cwd: '/', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      resolve(String(stdout));
    });
  });

/** Names every check must report. A missing name is a failure: a script that died early proves nothing. */
export const REQUIRED_CHECKS = [
  'uid', 'no-root-group', 'no-new-privs', 'CapPrm-empty', 'CapEff-empty', 'CapAmb-empty', 'CapInh-empty',
  'daemon-environ', 'init-environ', 'daemon-fds', 'daemon-cwd', 'daemon-mem', 'signal-daemon',
  'state-parent', 'state-root', 'state-db', 'state-write', 'run-dir-write', 'run-dir-read',
  'env-clean', 'proc-environ-scan', 'setuid-su', 'userns',
] as const;

export function judgeSelfCheck(output: string): SelfCheckResult {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const passed = new Set<string>();
  const failures: string[] = [];
  for (const l of lines) {
    const [verdict, name, ...rest] = l.split(' ');
    if (verdict === 'PASS' && name) passed.add(name);
    else if (verdict === 'FAIL' && name) failures.push(`${name}${rest.length ? `: ${rest.join(' ')}` : ''}`);
  }
  for (const name of REQUIRED_CHECKS) {
    if (!passed.has(name) && !failures.some((f) => f === name || f.startsWith(`${name}:`))) failures.push(`${name}: not reported`);
  }
  // A name that both passed and failed counts as failed.
  return { ok: failures.length === 0, failures, lines };
}

export async function runSelfCheck(cfg: PrivsepConfig, deps: SelfCheckDeps = {}): Promise<SelfCheckResult> {
  const args = [String(deps.pid ?? process.pid), cfg.stateDir, path.dirname(cfg.stateDir), cfg.agentRunDir, String(cfg.agentUid)];
  try {
    return judgeSelfCheck(await (deps.run ?? runAsWorkload)(SELF_CHECK_SCRIPT, args));
  } catch (err) {
    return { ok: false, failures: [`self-check did not run: ${(err as Error).message}`], lines: [] };
  }
}

let verdict: SelfCheckResult | null = null;

/** Record the verdict of this start (the daemon calls it once, before it listens). */
export function setSelfCheckVerdict(v: SelfCheckResult | null): void {
  verdict = v;
}

/** True only when the self-check of this start ran and every attempt failed as it should. */
export function privsepProven(): boolean {
  return verdict?.ok === true;
}
