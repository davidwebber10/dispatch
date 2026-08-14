import fs from 'fs';
import path from 'path';

export interface BrowserShimOptions {
  dataDir: string;
  serverUrl: string;
}

export type BrowserShimEnv = Record<'BROWSER' | 'GH_BROWSER' | 'DISPATCH_SERVER_URL' | 'PATH', string>;

/** Per-spawn env var (set by sessions/service.ts) naming which terminal a CLI is running in,
 *  so the shim can tell the operator WHICH agent/mission needs auth (see AuthBanner.tsx). */
export const TERMINAL_ID_ENV_VAR = 'DISPATCH_TERMINAL_ID';

/** The directory the shims are written to, for a given data dir. */
export function shimBinDir(dataDir: string): string {
  return path.join(dataDir, 'bin');
}

/**
 * Put the shim's bin dir back at the front of a PATH.
 *
 * Every contributor to the spawn environment (secrets, bundled tools, this shim) builds its
 * own PATH by prefixing `process.env.PATH`. Merging them with object spread means the LAST
 * one silently wins and the others' prefixes vanish — which is exactly how the whole
 * browser-auth relay came to be dead: `$BROWSER=dispatch-open` was set, but `dispatch-open`
 * was not on PATH, so any CLI honouring it just got "command not found".
 *
 * Call this after merging, so the shims are reachable no matter who else rebuilt PATH.
 */
export function withShimPath(dataDir: string, mergedPath: string | undefined): string {
  const dir = shimBinDir(dataDir);
  const rest = (mergedPath ?? '').split(path.delimiter).filter((p) => p && p !== dir);
  return [dir, ...rest].join(path.delimiter);
}

/** The system opener a CLI reaches for instead of `$BROWSER`, per platform. */
const SYSTEM_OPENERS = [
  { name: 'open', real: '/usr/bin/open' },      // macOS
  { name: 'xdg-open', real: null },             // Linux — resolved from PATH at run time
] as const;

export function installBrowserShim(options: BrowserShimOptions): BrowserShimEnv {
  const binDir = path.join(options.dataDir, 'bin');
  const shimPath = path.join(binDir, 'dispatch-open');

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(shimPath, buildShimScript(), { mode: 0o755 });
  fs.chmodSync(shimPath, 0o755);

  // Setting $BROWSER is not enough on its own: plenty of CLIs ignore it and exec the
  // platform opener directly (`open` on macOS, `xdg-open` on Linux). Shadowing those on
  // PATH catches them. The shims relay ONLY http(s) URLs and hand everything else to the
  // real binary, so `open .` and `open -a Xcode file.swift` keep working untouched.
  for (const opener of SYSTEM_OPENERS) {
    // Only shadow `open` where a real one exists — on Linux the name is unclaimed and
    // shadowing it would break any local script of that name.
    if (opener.real && !fs.existsSync(opener.real)) continue;
    const p = path.join(binDir, opener.name);
    fs.writeFileSync(p, buildOpenerShimScript(opener.name, opener.real, binDir), { mode: 0o755 });
    fs.chmodSync(p, 0o755);
  }

  const existingPath = process.env.PATH || '';
  return {
    BROWSER: 'dispatch-open',
    GH_BROWSER: 'dispatch-open',
    DISPATCH_SERVER_URL: options.serverUrl,
    PATH: existingPath ? `${binDir}:${existingPath}` : binDir,
  };
}

/**
 * A drop-in replacement for the system opener that relays URLs and delegates everything
 * else. `$1` is the first argument because that is where every opener takes its target;
 * anything that is not an http(s) URL (a path, a flag like `-a`) falls through to the real
 * binary with the original argv intact.
 */
function buildOpenerShimScript(name: string, realPath: string | null, binDir: string): string {
  // Linux has no fixed path for xdg-open, so find the next one on PATH that is not ours.
  const resolveReal = realPath
    ? `real=${shellQuote(realPath)}`
    : `real=""
old_ifs="$IFS"; IFS=:
for d in $PATH; do
  case "$d" in ${shellQuote(binDir)}) continue ;; esac
  if [ -x "$d/${name}" ]; then real="$d/${name}"; break; fi
done
IFS="$old_ifs"`;

  return `#!/bin/sh
${resolveReal}

case "$1" in
  http://*|https://*)
    if [ -n "$DISPATCH_SERVER_URL" ]; then
      ${relayCommand('"$1"', 'system-opener')}
      exit 0
    fi
    ;;
esac

# Not a URL (or we have nowhere to relay to) — behave exactly like the real opener.
if [ -n "$real" ] && [ -x "$real" ]; then
  exec "$real" "$@"
fi
exit 0
`;
}

/** The POST both shims make. Shared so the payload shape cannot drift between them. */
function relayCommand(urlExpr: string, source: string): string {
  const nodePath = shellQuote(process.execPath);
  const terminalIdRef = `"$${TERMINAL_ID_ENV_VAR}"`;
  return `payload="$(${nodePath} -e 'const [url, cwd, terminalId, source] = process.argv.slice(1); const body = { url, source, cwd }; if (terminalId) body.terminalId = terminalId; process.stdout.write(JSON.stringify(body));' ${urlExpr} "$(pwd)" ${terminalIdRef} ${shellQuote(source)} 2>/dev/null)"
      if [ -n "$payload" ]; then
        curl -fsS -X POST -H 'Content-Type: application/json' --data "$payload" "\${DISPATCH_SERVER_URL}/api/auth-requests" >/dev/null 2>&1 || true
      fi`;
}

function buildShimScript(): string {
  return `#!/bin/sh
url="$1"

if [ -z "$url" ] || [ -z "$DISPATCH_SERVER_URL" ]; then
  exit 0
fi

${relayCommand('"$url"', 'browser-env')}

exit 0
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
