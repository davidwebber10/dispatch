// packages/core/src/profile/host-context.ts
// The person's PROFILE and the facts about the host that the web page needs at launch.
//
// Dispatch is one product with two profiles, chosen per person by the hosting platform (Polywood OS):
//   • developer — everything, exactly as a local install has always shown it (the default);
//   • business  — the power-user features are hidden in the web page, and the daemon refuses the
//                 routes that would give a terminal or change the machine (profile/business-gate.ts).
// A local install sets none of these variables, so it is a developer with `hosted: false`, which is
// what it always was.
import { hostedTarget } from '../update/hosted.js';
import { boxCapabilities } from '../platform/capabilities.js';
import { envProfile } from '../os/profile.js';

export type Profile = 'business' | 'developer';
export const PROFILES: readonly Profile[] = ['business', 'developer'];

/** What the web page is told at launch (GET /api/host-context, and the meta tag in index.html). No secrets. */
export interface HostContext {
  profile: Profile;
  /** True on a box provisioned by OS (OS_BASE_URL + OS_BOX_TOKEN, update/hosted.ts). */
  hosted: boolean;
  /** The public address of OS, for the "Back to POLYWOOD OS" link. Null on a local install. */
  osBaseUrl: string | null;
  /** The person the box belongs to (DISPATCH_OWNER_EMAIL), when the platform says. */
  ownerEmail: string | null;
}

/**
 * DISPATCH_PROFILE → a profile. Absent or empty: developer. Any other value is a mistake of the
 * platform: developer (nothing hidden is the safer UI failure; the daemon gate then also stays off),
 * with one warning so the mistake is visible in the box log.
 */
export function readProfile(env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = (l) => console.warn(l)): Profile {
  const raw = env.DISPATCH_PROFILE?.trim().toLowerCase();
  if (!raw) return 'developer';
  if ((PROFILES as readonly string[]).includes(raw)) return raw as Profile;
  warn(`[profile] DISPATCH_PROFILE="${env.DISPATCH_PROFILE}" is not business or developer; using developer`);
  return 'developer';
}

/** Only an http(s) address is a link we put in the page. Anything else is dropped. */
function publicUrl(raw: string | undefined): string | null {
  const v = raw?.trim().replace(/\/+$/, '');
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The host context at boot, from the env alone. The profile here is the FALLBACK (os/profile.ts):
 * DISPATCH_PROFILE, else business on a hosted box (fail closed), else developer. A running daemon
 * serves `liveHostContext`, where OS's live answer wins.
 */
export function readHostContext(env: NodeJS.ProcessEnv = process.env, warn?: (line: string) => void): HostContext {
  const hosted = hostedTarget(env) !== null;
  // OS_BASE_URL is what the box uses to call OS (it can be a private address); OS_PUBLIC_URL is the
  // one a person's browser can open. Prefer the public one.
  const osBaseUrl = hosted ? publicUrl(env.OS_PUBLIC_URL) ?? publicUrl(env.OS_BASE_URL) : publicUrl(env.OS_PUBLIC_URL);
  const ownerEmail = env.DISPATCH_OWNER_EMAIL?.trim() || null;
  // A hosted box with no valid DISPATCH_PROFILE fails closed (business); readProfile still warns on a bad value.
  const fromEnv = readProfile(env, warn);
  const profile: Profile = hosted && envProfile(env) === null ? 'business' : fromEnv;
  return { profile, hosted, osBaseUrl, ownerEmail };
}

/** What GET /api/host-context answers: the context plus what this build enforces (platform/capabilities.ts). */
export interface HostContextResponse extends HostContext {
  capabilities: string[];
}

/**
 * The context NOW: the boot facts, the live profile (os/profile.ts) and OS's live public address when
 * OS sent one. Called per request, so a profile change from OS needs no restart.
 */
export function liveHostContext(base: HostContext, live: { profile: Profile; osPublicUrl?: string | null }): HostContext {
  const osBaseUrl = base.hosted ? publicUrl(live.osPublicUrl ?? undefined) ?? base.osBaseUrl : base.osBaseUrl;
  return { ...base, profile: live.profile, osBaseUrl };
}

export function hostContextResponse(ctx: HostContext): HostContextResponse {
  return { ...ctx, capabilities: boxCapabilities() };
}

/** True when the page must be told: a hosted box, or a profile set on purpose. Else the page keeps its defaults. */
export function hostContextIsDefault(ctx: HostContext): boolean {
  return ctx.profile === 'developer' && !ctx.hosted && ctx.osBaseUrl === null && ctx.ownerEmail === null;
}

/** The meta tag the daemon puts into index.html (see web-assets.ts). The web reads it before its first paint. */
export const HOST_CONTEXT_META = 'dispatch-host-context';

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * index.html with the host context as a `<meta>` (not a script: the CSP is `script-src 'self'`).
 * A default context adds nothing, so a local install serves the same bytes as before.
 */
export function indexHtmlWithHostContext(html: string, ctx: HostContext): string {
  if (hostContextIsDefault(ctx)) return html;
  const tag = `<meta name="${HOST_CONTEXT_META}" content="${escapeAttr(JSON.stringify(ctx))}" />`;
  return html.includes('</head>') ? html.replace('</head>', `    ${tag}\n  </head>`) : tag + html;
}
