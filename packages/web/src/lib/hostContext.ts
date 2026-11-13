// The host context: the person's profile and the facts about the host (daemon: core/src/profile/host-context.ts).
//
// The daemon puts it into index.html as `<meta name="dispatch-host-context">` on a hosted box or when a
// profile is set, so it is known before the first paint and nothing flashes. A local install has no
// meta: the defaults below are then exactly the old behaviour (developer, not hosted).

export type Profile = 'business' | 'developer';

export interface HostContext {
  profile: Profile;
  hosted: boolean;
  /** The public address of Polywood OS (the way back). Null on a local install. */
  osBaseUrl: string | null;
  ownerEmail: string | null;
}

export const DEFAULT_HOST_CONTEXT: HostContext = Object.freeze({ profile: 'developer', hosted: false, osBaseUrl: null, ownerEmail: null });

export const HOST_CONTEXT_META = 'dispatch-host-context';

/** Accept only the shape the daemon sends; anything else is the default (developer, local). */
export function parseHostContext(raw: unknown): HostContext {
  if (!raw || typeof raw !== 'object') return DEFAULT_HOST_CONTEXT;
  const r = raw as Record<string, unknown>;
  const osBaseUrl = typeof r.osBaseUrl === 'string' && /^https?:\/\//i.test(r.osBaseUrl) ? r.osBaseUrl : null;
  return {
    profile: r.profile === 'business' ? 'business' : 'developer',
    hosted: r.hosted === true,
    osBaseUrl,
    ownerEmail: typeof r.ownerEmail === 'string' && r.ownerEmail ? r.ownerEmail : null,
  };
}

function readMeta(): HostContext {
  try {
    if (typeof document === 'undefined') return DEFAULT_HOST_CONTEXT;
    const content = document.querySelector(`meta[name="${HOST_CONTEXT_META}"]`)?.getAttribute('content');
    return content ? parseHostContext(JSON.parse(content)) : DEFAULT_HOST_CONTEXT;
  } catch {
    return DEFAULT_HOST_CONTEXT;
  }
}

/**
 * "Preview as business user" (Settings > Appearance, developer profile only): this browser shows the
 * business feature map, the OS theme rules and the plain wording, so the owner can see what a business
 * person sees. UI only: the daemon keeps its own profile (developer), so nothing is enforced.
 * Saved per browser; switching it reloads the page (the profile is fixed for the life of a page).
 */
export const PREVIEW_BUSINESS_KEY = 'dispatch:previewBusiness';

function readPreview(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(PREVIEW_BUSINESS_KEY) === '1'; } catch { return false; }
}

let real: HostContext = readMeta();
let preview = real.profile === 'developer' && readPreview();

/** The profile the daemon reports for this workspace (never the preview). */
export function realHostContext(): HostContext {
  return real;
}

/** The host context the UI follows: the real one, with profile 'business' while the preview is on. */
export function hostContext(): HostContext {
  return preview ? { ...real, profile: 'business' } : real;
}

/** True while a developer previews the business experience in this browser. */
export function isBusinessPreview(): boolean {
  return preview;
}

/** Turn the preview on or off in this browser, then reload so every part of the page follows. */
export function setBusinessPreview(on: boolean, reload: () => void = () => window.location.reload()): void {
  if (real.profile !== 'developer') return;
  try { if (on) localStorage.setItem(PREVIEW_BUSINESS_KEY, '1'); else localStorage.removeItem(PREVIEW_BUSINESS_KEY); } catch { /* private mode */ }
  reload();
}

/** Test seam: set the context and the preview. Pass nothing to read the page's meta and storage again. */
export function setHostContextForTest(ctx?: Partial<HostContext>, previewOn = false): void {
  real = ctx ? { ...DEFAULT_HOST_CONTEXT, ...ctx } : readMeta();
  preview = ctx ? real.profile === 'developer' && previewOn : real.profile === 'developer' && readPreview();
}

export const isHosted = (): boolean => real.hosted;

/**
 * The workspace looks like OS (OS theme pair, OS left rail, product brand control): ONLY when it is asked
 * for, by the business preview (an explicit switch, off by default). Since 2026-11-11 a hosted box does
 * NOT imply it: a person on a hosted box uses the chat view inside OS (docs/headless-api.md), and this
 * page is the developer's "native" window, which looks like a local install (standard theme, IconRail).
 */
export const usesOsLook = (): boolean => preview;

/**
 * The page uses plain wording (lib/hostCopy.ts): a business person on a hosted box, or the business
 * preview. A developer's native window on a hosted box reads like a local install.
 */
export const usesPlainWording = (): boolean => (real.hosted && real.profile === 'business') || preview;

/**
 * A profile change from OS (core os/profile.ts) without a restart: on a hosted workspace the page asks
 * the daemon for the host context every minute, and at once when the daemon says OS's answer changed
 * (`os:connections`). When the profile differs from the one this page was built with, the page
 * reloads ONCE at the base path, so every part (feature map, theme, wording) follows. Anything that is
 * not the daemon's JSON (the OS launcher page, a router 302/503/409) is ignored here: lib/boxRestart.ts
 * owns that case. A local install never polls.
 */
const WATCH_MS = 60_000;
let watching: ReturnType<typeof setInterval> | null = null;
let reloading = false;

export async function checkHostContextNow(opts: { fetchImpl?: typeof fetch; reload?: () => void; url?: string } = {}): Promise<boolean> {
  if (!real.hosted || reloading) return false;
  try {
    const f = opts.fetchImpl ?? fetch;
    const res = await f(opts.url ?? hostContextUrl(), { redirect: 'manual', cache: 'no-store', headers: { Accept: 'application/json' } });
    const json = /application\/json/i.test(res.headers?.get?.('content-type') ?? '');
    if (!res.ok || !json || res.redirected || res.type === 'opaqueredirect') return false;
    const next = parseHostContext(await res.json());
    if (next.profile === real.profile) return false;
    reloading = true;
    (opts.reload ?? (() => location.replace(reloadUrl())))();
    return true;
  } catch {
    return false;
  }
}

export function watchHostContext(): () => void {
  if (!real.hosted || watching) return () => {};
  watching = setInterval(() => { void checkHostContextNow(); }, WATCH_MS);
  return () => { if (watching) clearInterval(watching); watching = null; };
}

// The base path from <base href> (the same rule as lib/basePath.ts, which this first-load module does not import).
function base(): string {
  try { return new URL(document.baseURI).pathname.replace(/\/+$/, ''); } catch { return ''; }
}
function hostContextUrl(): string { return `${base()}/api/host-context`; }
function reloadUrl(): string { return `${base()}/${location.pathname.startsWith(base() + '/') ? location.pathname.slice(base().length + 1) : ''}${location.search}`; }

/** Test seam. */
export function resetHostContextWatch(): void { reloading = false; if (watching) clearInterval(watching); watching = null; }
