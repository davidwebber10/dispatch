// packages/core/src/privsep/config.ts
// Privilege separation on a hosted box (docs/hosted-privilege-separation.md). The daemon runs as
// root with a reduced capability set; every process it starts runs as the unprivileged agent user.
// This file only reads the switch. With DISPATCH_PRIVSEP unset (every local install) `privsep()`
// is null and no other file in this folder changes anything.
import path from 'node:path';

export interface PrivsepConfig {
  /** The user and group every workload runs as. */
  agentUid: number;
  agentGid: number;
  /** Daemon state: database, settings, registry files. Not reachable by the agent user. */
  stateDir: string;
  /** Files the daemon writes for a workload to read. Owned by root; rebuilt at each start. */
  agentRunDir: string;
  /** Files a workload must write and keep (below the person's home). */
  agentDataDir: string;
  /** The person's home. Everything in it is untrusted input. */
  agentHome: string;
}

const intOf = (v: string | undefined): number | null => {
  if (!v || !/^\d{1,9}$/.test(v.trim())) return null;
  return Number(v.trim());
};

/**
 * Read the configuration from an environment. Throws when the switch is on and a value is missing
 * or unsafe: a box that asked for the separation must never run without it.
 */
export function readPrivsep(env: NodeJS.ProcessEnv, currentUid: number | null): PrivsepConfig | null {
  const v = env.DISPATCH_PRIVSEP?.trim();
  if (v !== '1' && v !== 'true') return null;
  const agentUid = intOf(env.DISPATCH_AGENT_UID);
  const agentGid = intOf(env.DISPATCH_AGENT_GID);
  if (agentUid === null || agentGid === null) throw new Error('DISPATCH_PRIVSEP is set, but DISPATCH_AGENT_UID / DISPATCH_AGENT_GID are not numbers.');
  if (agentUid === 0 || agentGid === 0) throw new Error('DISPATCH_PRIVSEP: the agent user must not be root.');
  if (currentUid !== 0) throw new Error('DISPATCH_PRIVSEP is set, but the daemon does not run as root: it could not start a process as the agent user.');
  const abs = (name: string): string => {
    const p = env[name]?.trim();
    if (!p || !path.isAbsolute(p)) throw new Error(`DISPATCH_PRIVSEP is set, but ${name} is not an absolute path.`);
    return path.resolve(p);
  };
  const agentHome = abs('HOME');
  const stateDir = abs('DISPATCH_STATE_DIR');
  const agentRunDir = abs('DISPATCH_AGENT_RUN_DIR');
  const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
  if (inside(stateDir, agentHome) || inside(agentRunDir, agentHome)) {
    throw new Error('DISPATCH_PRIVSEP: the state and run directories must be outside the home.');
  }
  return { agentUid, agentGid, stateDir, agentRunDir, agentDataDir: path.join(agentHome, '.dispatch'), agentHome };
}

let cached: PrivsepConfig | null | undefined;

/** The active configuration, or null (a local install, tests). Read once from the process environment. */
export function privsep(): PrivsepConfig | null {
  if (cached === undefined) cached = readPrivsep(process.env, typeof process.getuid === 'function' ? process.getuid() : null);
  return cached;
}

/** Tests only. */
export function setPrivsepForTest(cfg: PrivsepConfig | null | undefined): void {
  cached = cfg;
}
