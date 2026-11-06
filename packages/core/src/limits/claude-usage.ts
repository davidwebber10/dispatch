// packages/core/src/limits/claude-usage.ts
// Claude's usage straight from Anthropic (2026-11-06): the same figures claude.ai's usage page shows,
// per-model weekly windows (Fable, Opus, Sonnet) and extra-usage spend included. The Claude Code
// login is enough: `GET api.anthropic.com/api/oauth/usage` with the OAuth token the CLI holds, no
// turn needed. Before this the gauge ran a tiny Claude turn and read the stream's rate_limit_event,
// which names no per-model window, so "Fable" was really the weekly-with-extra figure.
//
// The token, in order: Dispatch's own saved login (the thread spawn env), the CLI's credentials
// file, then the macOS keychain item the CLI writes. The token is never refreshed here: a refresh
// would spend the CLI's refresh token; an expired token simply fails the read, and the old probe
// (claude-probe.ts) runs a turn, which makes the CLI refresh it for next time.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import type { LimitSnapshots, LimitWindows, ProviderExtras } from './snapshot.js';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01', Accept: 'application/json', 'User-Agent': 'dispatch' };
const TIMEOUT_MS = 15_000;
const PROFILE_TTL_MS = 60 * 60_000;

const pct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null);
const iso = (v: unknown): number | null => { if (typeof v !== 'string') return null; const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** The window key of one `limits[]` entry: `seven_day` for the all-models weekly, `seven_day_<model>` for a scoped one. */
export function limitKey(l: any): string | null {
  const kind = typeof l?.kind === 'string' ? l.kind : '';
  const model = l?.scope?.model;
  const name = typeof model?.display_name === 'string' && model.display_name ? model.display_name : typeof model?.id === 'string' && model.id ? model.id : '';
  if (kind === 'weekly_all') return 'seven_day';
  if (kind === 'weekly_scoped') return name ? `seven_day_${slug(name)}` : null;
  if (kind === 'five_hour' || kind === 'session') return 'five_hour';
  if (!kind) return null;
  return name ? `${kind}_${slug(name)}` : kind;
}

/**
 * Windows, spend and plan from an `/api/oauth/usage` body. Percents there are 0-100 already. The
 * legacy top-level fields (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, ...) come
 * first; `limits[]` then adds or overrides (newer accounts null the legacy per-model fields out).
 */
export function parseClaudeUsage(body: any): { windows: LimitWindows; extras: ProviderExtras } {
  const windows: LimitWindows = {};
  const extras: ProviderExtras = {};
  if (!body || typeof body !== 'object') return { windows, extras };
  for (const [key, w] of Object.entries(body)) {
    if (!w || typeof w !== 'object' || !/^(five_hour|seven_day(_[a-z_]+)?)$/.test(key)) continue;
    const used = pct((w as any).utilization);
    const resetsAt = iso((w as any).resets_at);
    if (used !== null || resetsAt !== null) windows[key] = { usedPercent: used, resetsAt };
  }
  if (Array.isArray(body.limits)) {
    for (const l of body.limits) {
      const key = limitKey(l);
      if (!key) continue;
      const used = pct(l.percent);
      const resetsAt = iso(l.resets_at);
      if (used !== null || resetsAt !== null) windows[key] = { usedPercent: used, resetsAt };
    }
  }
  const x = body.extra_usage;
  if (x && typeof x === 'object' && x.is_enabled !== false) {
    const used = Number(x.used_credits);
    const limit = Number(x.monthly_limit);
    if (Number.isFinite(used)) {
      extras.spend = { usedMinor: Math.round(used), limitMinor: Number.isFinite(limit) && limit > 0 ? Math.round(limit) : null, currency: typeof x.currency === 'string' ? x.currency : 'USD' };
      const u = pct(x.utilization);
      if (u !== null) windows.overage = { usedPercent: u, resetsAt: null };
    }
  }
  return { windows, extras };
}

// --- the token -------------------------------------------------------------------------------

interface Cred { token: string; expiresAt: number | null }

function fromCredentialsFile(home: string, env: NodeJS.ProcessEnv): Cred | null {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  for (const name of ['.credentials.json', 'credentials.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const o = j?.claudeAiOauth;
      if (typeof o?.accessToken === 'string' && o.accessToken) return { token: o.accessToken, expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null };
    } catch { /* next */ }
  }
  return null;
}

let keychainCache: { at: number; cred: Cred | null } | null = null;
function fromKeychain(now: number): Promise<Cred | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  if (keychainCache && now - keychainCache.at < 60_000) return Promise.resolve(keychainCache.cred);
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (err, stdout) => {
      let cred: Cred | null = null;
      if (!err) {
        try { const o = JSON.parse(String(stdout).trim())?.claudeAiOauth; if (typeof o?.accessToken === 'string' && o.accessToken) cred = { token: o.accessToken, expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null }; } catch { /* not JSON */ }
      }
      keychainCache = { at: now, cred };
      resolve(cred);
    });
  });
}

export interface TokenSourceOpts {
  /** Dispatch's own saved login (ClaudeLoginService), when the owner signed in through the app. */
  saved?: () => string | null;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  keychain?: (now: number) => Promise<Cred | null>;
}

/** The best current Claude OAuth token: the saved login, else the later-expiring of the CLI's file and keychain logins. */
export async function readClaudeToken(opts: TokenSourceOpts = {}): Promise<string | null> {
  const saved = opts.saved?.();
  if (saved) return saved;
  const now = (opts.now ?? Date.now)();
  const file = fromCredentialsFile(opts.home ?? os.homedir(), opts.env ?? process.env);
  const kc = await (opts.keychain ?? fromKeychain)(now);
  const live = [file, kc].filter((c): c is Cred => !!c && (c.expiresAt === null || c.expiresAt > now));
  live.sort((a, b) => (b.expiresAt ?? Infinity) - (a.expiresAt ?? Infinity));
  return live[0]?.token ?? file?.token ?? kc?.token ?? null;
}

// --- the reader ------------------------------------------------------------------------------

export interface ClaudeUsageDeps {
  snapshots: LimitSnapshots;
  accountFor: (provider: string) => string;
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

async function getJson(f: typeof fetch, url: string, token: string): Promise<{ status: number; body: any } | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await f(url, { headers: { ...HEADERS, Authorization: `Bearer ${token}` }, signal: ctl.signal });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: res.status, body };
  } catch { return null; } finally { clearTimeout(t); }
}

/** One read: fetch the usage (and, hourly, the plan name), record it. True when figures were recorded. */
export function createClaudeUsageReader(d: ClaudeUsageDeps): () => Promise<boolean> {
  const now = d.now ?? Date.now;
  const f = d.fetch ?? fetch;
  const log = d.log ?? ((l: string) => console.log(l));
  let profile: { key: string; at: number; plan?: string } | null = null;
  let lastFailure = '';
  return async () => {
    const token = await d.token();
    if (!token) return false;
    const r = await getJson(f, USAGE_URL, token);
    if (!r || r.status !== 200 || !r.body) {
      const why = r ? `HTTP ${r.status}` : 'no answer';
      if (why !== lastFailure) { log(`[usage] Claude usage read failed: ${why}`); lastFailure = why; }
      return false;
    }
    lastFailure = '';
    const { windows, extras } = parseClaudeUsage(r.body);
    if (!Object.keys(windows).length) return false;
    const key = createHash('sha256').update(token).digest('hex').slice(0, 12);
    const t = now();
    if (!profile || profile.key !== key || t - profile.at > PROFILE_TTL_MS) {
      const p = await getJson(f, PROFILE_URL, token);
      const plan = typeof p?.body?.organization?.plan_display_name === 'string' ? p.body.organization.plan_display_name : undefined;
      profile = { key, at: t, plan: plan ?? profile?.plan };
    }
    // The body lists every window the account has: replace, so a window that went away does not linger.
    d.snapshots.record('claude-code', d.accountFor('claude-code'), windows, t, profile.plan, true, extras);
    return true;
  };
}
