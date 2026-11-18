// packages/core/src/platform/box-secrets.ts
// The two secrets of a hosted box, and the rule that each has ONE job.
//
//   DISPATCH_BOX_TOKEN   INBOUND only: the platform's router sends it on every request to this daemon
//                        (auth/box-token.ts). The daemon never sends it anywhere.
//   OS_BOX_TOKEN         OUTBOUND only: the daemon sends it on its own calls to the platform (company
//                        tools, connections, heartbeat, update). The daemon never accepts it from a caller.
//
// One value in both roles means a single leak is both "act as the owner on this box" and "act as this
// box on the platform". So a hosted daemon REFUSES TO START when the two are set and equal, unless
// DISPATCH_ALLOW_SHARED_BOX_TOKEN=1 says the platform still issues one value (a compatibility mode,
// logged at every start, to be removed once the platform issues two).
//
// The daemon reads both ONCE (`takeBoxSecrets`, the first thing `startServer` does), keeps them in this
// module, and deletes them from `process.env`. From then on NO child process can inherit them, whatever
// code starts it and whatever env it passes: a harness, a shell, an MCP bridge, a plugin worker, a
// probe, git. (`platform/inherited-env.ts` still removes the names from an env it is given, for a
// build that never called `takeBoxSecrets`: the tests.)
//
// What this does NOT do: a process that runs as the daemon's own operating-system user can still read
// the daemon's memory and its first environment block (/proc/<pid>/environ keeps the block the process
// was started with). Closing that needs the agent to run as another user.
//
// PRIVILEGE SEPARATION HOOKS IN HERE: when the agents run under another uid, the platform (or a
// root-owned helper) should hand the two values to the daemon through a file or descriptor that the
// agent's user cannot read, and `takeBoxSecrets` is the one place that would read it. Nothing else in
// the daemon reads either variable.
export type BoxTokenMode =
  /** No platform: an ordinary local install. */
  | 'local'
  /** Hosted, two different values: each has one job. */
  | 'split'
  /** Hosted, one value in both roles, allowed by DISPATCH_ALLOW_SHARED_BOX_TOKEN=1. */
  | 'shared-compat'
  /** Hosted, no inbound token: requests to the daemon are not checked (a local trial only). */
  | 'no-inbound';

export const SHARED_TOKEN_SWITCH = 'DISPATCH_ALLOW_SHARED_BOX_TOKEN';

export class SharedBoxTokenError extends Error {
  constructor() {
    super(
      'DISPATCH_BOX_TOKEN and OS_BOX_TOKEN hold the same value. Each must have one job: the first admits requests to this ' +
      'workspace, the second signs this workspace\'s calls to the platform. Issue two different values, or set ' +
      `${SHARED_TOKEN_SWITCH}=1 to accept one value for now. Refusing to start.`,
    );
    this.name = 'SharedBoxTokenError';
  }
}

interface Held { inbound?: string; outbound?: string }
let held: Held = {};
let taken = false;

const clean = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

/** Which mode an environment describes. Throws SharedBoxTokenError for one value in both roles without the switch. */
export function boxTokenMode(env: NodeJS.ProcessEnv): BoxTokenMode {
  const inbound = clean(env.DISPATCH_BOX_TOKEN);
  const outbound = clean(env.OS_BOX_TOKEN);
  const hosted = !!(clean(env.OS_BASE_URL) && outbound);
  if (!hosted) return 'local';
  if (!inbound) return 'no-inbound';
  if (inbound !== outbound) return 'split';
  if (env[SHARED_TOKEN_SWITCH]?.trim() === '1') return 'shared-compat';
  throw new SharedBoxTokenError();
}

/**
 * Read the two secrets from `process.env` into this module and remove them from it. Call once, before
 * anything is spawned. Returns the mode (and throws like `boxTokenMode`). Never logs a value.
 */
export function takeBoxSecrets(env: NodeJS.ProcessEnv = process.env): BoxTokenMode {
  const mode = boxTokenMode(env);
  held = { inbound: clean(env.DISPATCH_BOX_TOKEN), outbound: clean(env.OS_BOX_TOKEN) };
  taken = true;
  delete env.DISPATCH_BOX_TOKEN;
  delete env.OS_BOX_TOKEN;
  return mode;
}

/** True once `takeBoxSecrets` ran in this process. */
export const boxSecretsTaken = (): boolean => taken;

/**
 * The token that admits a request to this daemon. Read from `env` when it is there (a test build gives
 * its own env); for the process's own env, from what `takeBoxSecrets` kept.
 */
export function inboundBoxToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return clean(env.DISPATCH_BOX_TOKEN) ?? (env === process.env ? held.inbound : undefined);
}

/** The token the daemon sends to the platform. Same lookup as `inboundBoxToken`. */
export function osBoxToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return clean(env.OS_BOX_TOKEN) ?? (env === process.env ? held.outbound : undefined);
}

/** One line for the log: the mode in plain words. No value, no length, no hash. */
export function describeBoxTokenMode(mode: BoxTokenMode): string {
  switch (mode) {
    case 'local': return 'box tokens: none (a local install)';
    case 'split': return 'box tokens: split (one admits requests, another signs calls to the platform)';
    case 'shared-compat': return `box tokens: SHARED (compatibility, ${SHARED_TOKEN_SWITCH}=1): one value does both jobs. Issue two values and remove the switch.`;
    case 'no-inbound': return 'box tokens: NO INBOUND TOKEN: requests to this workspace are not checked. A local trial only.';
  }
}

/** Test seam: forget what was taken. */
export function resetBoxSecretsForTests(): void { held = {}; taken = false; }
