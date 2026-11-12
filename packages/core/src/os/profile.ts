// packages/core/src/os/profile.ts
// The person's profile as the daemon knows it NOW: OS's answer (authoritative, can change at any
// time, os/tools-proxy.ts) when there is one, else DISPATCH_PROFILE, else developer. One process-wide
// source, so a spawn reads the current value without a restart. A local install: always developer.
export type Profile = 'business' | 'developer';

let source: () => Profile = () => envProfile(process.env);

export function envProfile(env: NodeJS.ProcessEnv): Profile {
  return env.DISPATCH_PROFILE?.trim().toLowerCase() === 'business' ? 'business' : 'developer';
}

/** The daemon sets the source once at build (OS's answer, then the env). */
export function setProfileSource(fn: () => Profile): void { source = fn; }

export function currentProfile(): Profile {
  try { return source(); } catch { return 'developer'; }
}
