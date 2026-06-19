import fs from 'fs';
import path from 'path';

export interface BrowserShimOptions {
  dataDir: string;
  serverUrl: string;
}

export type BrowserShimEnv = Record<'BROWSER' | 'GH_BROWSER' | 'DISPATCH_SERVER_URL' | 'PATH', string>;

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

  return `#!/bin/sh
url="$1"

if [ -z "$url" ] || [ -z "$DISPATCH_SERVER_URL" ]; then
  exit 0
fi

cwd="$(pwd)"
payload="$(${nodePath} -e 'const [url, cwd] = process.argv.slice(1); process.stdout.write(JSON.stringify({ url, source: "browser-env", cwd }));' "$url" "$cwd" 2>/dev/null)"

if [ -n "$payload" ]; then
  curl -fsS -X POST -H 'Content-Type: application/json' --data "$payload" "\${DISPATCH_SERVER_URL}/api/auth-requests" >/dev/null 2>&1 || true
fi

exit 0
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
