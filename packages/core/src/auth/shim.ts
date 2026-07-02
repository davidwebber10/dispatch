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

export function installBrowserShim(options: BrowserShimOptions): BrowserShimEnv {
  const binDir = path.join(options.dataDir, 'bin');
  const shimPath = path.join(binDir, 'dispatch-open');

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(shimPath, buildShimScript(), { mode: 0o755 });
  fs.chmodSync(shimPath, 0o755);

  const existingPath = process.env.PATH || '';
  return {
    BROWSER: 'dispatch-open',
    GH_BROWSER: 'dispatch-open',
    DISPATCH_SERVER_URL: options.serverUrl,
    PATH: existingPath ? `${binDir}:${existingPath}` : binDir,
  };
}

function buildShimScript(): string {
  const nodePath = shellQuote(process.execPath);
  // A shell reference to the terminal-id env var, e.g. "$DISPATCH_TERMINAL_ID" — built from
  // the shared constant so the script and sessions/service.ts (which sets the var) can't drift.
  const terminalIdRef = `"$${TERMINAL_ID_ENV_VAR}"`;

  return `#!/bin/sh
url="$1"

if [ -z "$url" ] || [ -z "$DISPATCH_SERVER_URL" ]; then
  exit 0
fi

cwd="$(pwd)"
payload="$(${nodePath} -e 'const [url, cwd, terminalId] = process.argv.slice(1); const body = { url, source: "browser-env", cwd }; if (terminalId) body.terminalId = terminalId; process.stdout.write(JSON.stringify(body));' "$url" "$cwd" ${terminalIdRef} 2>/dev/null)"

if [ -n "$payload" ]; then
  curl -fsS -X POST -H 'Content-Type: application/json' --data "$payload" "\${DISPATCH_SERVER_URL}/api/auth-requests" >/dev/null 2>&1 || true
fi

exit 0
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
