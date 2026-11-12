// packages/core/src/privsep/secrets.ts
// The two tokens of a hosted box, held in the daemon's memory only (design section 5).
//
//   inbound   DISPATCH_BOX_TOKEN   the router and the control plane send it; the box verifies it
//   outbound  OS_BOX_TOKEN         the daemon sends it to the platform
//
// On a box with privilege separation the entrypoint passes them through a pipe (the descriptor
// number is in DISPATCH_SECRETS_FD) and removes them from the daemon's environment; `loadBoxSecrets`
// (privsep/install.ts) reads the pipe once and scrubs what is left. Every reader asks `boxSecret`.
// Without privilege separation nothing is loaded and `boxSecret` reads the environment as before.
import fs from 'node:fs';

export const SECRET_NAMES = ['DISPATCH_BOX_TOKEN', 'OS_BOX_TOKEN'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/**
 * Variables that must never be in the daemon's environment after the start, nor in a child's: the
 * tokens, the descriptor variable, and what locates the task's cloud credentials and metadata.
 */
export const NEVER_INHERITED = [
  ...SECRET_NAMES,
  'DISPATCH_BOX_TOKEN_SHA256',
  'DISPATCH_SECRETS_FD',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'ECS_CONTAINER_METADATA_URI',
  'ECS_CONTAINER_METADATA_URI_V4',
  'ECS_AGENT_URI',
] as const;

const held = new Map<SecretName, string>();
let loaded = false;

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
 * Load the secrets once and scrub the environment. Idempotent. `env` is the process environment in
 * the daemon; tests pass their own object and a reader.
 */
export function loadBoxSecrets(env: NodeJS.ProcessEnv = process.env, read: (fd: number) => string = readFd): void {
  if (loaded && env === process.env) return;
  const fdText = env.DISPATCH_SECRETS_FD?.trim();
  if (fdText) {
    if (!/^\d{1,4}$/.test(fdText) || Number(fdText) < 3) throw new Error('DISPATCH_SECRETS_FD is not a descriptor number.');
    const fd = Number(fdText);
    const text = read(fd);
    for (const [name, value] of Object.entries(parseSecrets(text))) held.set(name as SecretName, value!);
  }
  for (const name of SECRET_NAMES) {
    const v = env[name]?.trim();
    if (v && !held.has(name)) held.set(name, v);
  }
  for (const name of NEVER_INHERITED) delete env[name];
  if (env === process.env) loaded = true;
}

/**
 * A secret by name. After `loadBoxSecrets()` ran on the process environment (a box with privilege
 * separation): the held value. Before that, or with any other environment object (a local trial,
 * tests, a build with an injected env): that environment's own value, read live as before.
 */
export function boxSecret(name: SecretName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env === process.env && loaded) return held.get(name);
  return env[name]?.trim() || undefined;
}

/** True once the secrets were moved out of the process environment. */
export function boxSecretsLoaded(): boolean {
  return loaded;
}

/** Tests only: forget everything. */
export function resetBoxSecretsForTest(): void {
  held.clear();
  loaded = false;
}
