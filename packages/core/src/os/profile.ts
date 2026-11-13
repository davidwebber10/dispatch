// packages/core/src/os/profile.ts
// The person's profile as the daemon knows it NOW. ONE source for every reader: the business route
// gate (profile/business-gate.ts), GET /api/host-context and the page's meta (profile/host-context.ts),
// the terminal-socket refusal (daemon/sockets.ts), the approvals default (os/approvals.ts) and the
// heartbeat. The order:
//   1. OS's answer (`profile` in /api/dispatch/connections, refreshed with the connections fetch,
//      integrations/os-provider.ts). The provider keeps the LAST answer while OS is unreachable.
//   2. DISPATCH_PROFILE, when OS never answered.
//   3. Neither: `business` on a hosted box (fail closed), `developer` on a local install.
// A change from OS takes effect at the next request; nothing needs a restart.
import { hostedTarget } from '../update/hosted.js';

export type Profile = 'business' | 'developer';

/** DISPATCH_PROFILE when it names a profile; null when it is absent or not a profile. */
export function envProfile(env: NodeJS.ProcessEnv): Profile | null {
  const v = env.DISPATCH_PROFILE?.trim().toLowerCase();
  return v === 'business' || v === 'developer' ? v : null;
}

/** The profile before OS answers: the env value, else business on a hosted box, else developer. */
export function fallbackProfile(env: NodeJS.ProcessEnv): Profile {
  return envProfile(env) ?? (hostedTarget(env) !== null ? 'business' : 'developer');
}

/** OS's live value (null until OS answered once) over the fallback. */
export function resolveProfile(osProfile: Profile | null | undefined, env: NodeJS.ProcessEnv): Profile {
  return osProfile ?? fallbackProfile(env);
}

let source: () => Profile = () => fallbackProfile(process.env);

/** The daemon sets the source once at build (OS's answer, then the env). */
export function setProfileSource(fn: () => Profile): void { source = fn; }

/** The profile now. A source that throws is treated as the fallback of the process env. */
export function currentProfile(): Profile {
  try { return source(); } catch { return fallbackProfile(process.env); }
}
