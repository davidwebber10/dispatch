// packages/core/src/privsep/secrets.ts
// How the two box secrets reach the daemon on a box with privilege separation (design section 5).
//
// The holder is platform/box-secrets.ts: `takeBoxSecrets` moves DISPATCH_BOX_TOKEN and OS_BOX_TOKEN
// out of `process.env` into memory, and every reader asks it. This file is the step BEFORE that. The
// entrypoint does not put the two values in the daemon's environment at all: it writes them into a
// pipe and passes the descriptor number in DISPATCH_SECRETS_FD. `loadBoxSecrets` reads the pipe once
// and sets the two variables in `process.env` for `takeBoxSecrets` to take. Setting a variable in a
// running process does not change the block /proc/<pid>/environ shows (the one the process was
// started with), so the values are never in any environment another process can read.
//
// It also removes what locates the task's cloud credentials and metadata: the daemon does not use
// them, and no process it starts may inherit them.
import fs from 'node:fs';

export const SECRET_NAMES = ['DISPATCH_BOX_TOKEN', 'OS_BOX_TOKEN'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** Variables that no process the daemon starts may see (the spawn guard removes them from every child). */
export const NEVER_INHERITED = [
  ...SECRET_NAMES,
  'DISPATCH_SECRETS_FD',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'ECS_CONTAINER_METADATA_URI',
  'ECS_CONTAINER_METADATA_URI_V4',
  'ECS_AGENT_URI',
] as const;

/** What `loadBoxSecrets` deletes from the daemon's own environment: everything above but the two tokens it just set. */
const SCRUBBED_AT_LOAD = NEVER_INHERITED.filter((n) => !(SECRET_NAMES as readonly string[]).includes(n));

const MAX_BYTES = 16 * 1024;

/** Parse the pipe's content: one JSON object of string values. Unknown names are ignored. */
export function parseSecrets(text: string): Partial<Record<SecretName, string>> {
  const out: Partial<Record<SecretName, string>> = {};
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('The secrets descriptor did not hold JSON.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The secrets descriptor did not hold an object.');
  for (const name of SECRET_NAMES) {
    const v = (raw as Record<string, unknown>)[name];
    if (typeof v === 'string' && v.trim()) out[name] = v.trim();
  }
  return out;
}

/** Read the descriptor to its end and close it (also when the read fails). */
function readFd(fd: number): string {
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(4096);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      total += n;
      if (total > MAX_BYTES) throw new Error('The secrets descriptor holds too much data.');
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Read the secrets from the descriptor into `env` (for `takeBoxSecrets`), and remove the descriptor
 * variable and the credential locators from it. Without a descriptor variable only the removal
 * happens. Returns the names that came through the descriptor. Never logs a value.
 */
export function loadBoxSecrets(env: NodeJS.ProcessEnv = process.env, read: (fd: number) => string = readFd): SecretName[] {
  const loaded: SecretName[] = [];
  const fdText = env.DISPATCH_SECRETS_FD?.trim();
  if (fdText) {
    if (!/^\d{1,4}$/.test(fdText) || Number(fdText) < 3) throw new Error('DISPATCH_SECRETS_FD is not a descriptor number.');
    for (const [name, value] of Object.entries(parseSecrets(read(Number(fdText))))) {
      env[name] = value;
      loaded.push(name as SecretName);
    }
  }
  for (const name of SCRUBBED_AT_LOAD) delete env[name];
  return loaded;
}
