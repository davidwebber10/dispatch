export const PROVIDERS = ['claude', 'codex', 'opencode', 'grok', 'other'] as const;
const PLATFORMS = ['darwin', 'wsl', 'linux'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TOP_KEYS = ['v', 'installId', 'version', 'platform', 'days', 'projects'];
const DAY_KEYS = ['day', 'providers', 'threads', 'chatTurns'];
const TOT_KEYS = ['turns', 'input', 'output', 'cacheRead', 'cacheWrite'];

export interface Totals { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export interface PingDay { day: string; providers: Record<string, Totals>; threads: number; chatTurns: number }
export interface Ping { installId: string; version: string; platform: string; days: PingDay[]; projects: number }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
const onlyKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

export function validatePing(b: unknown, now: Date): { ok: true; ping: Ping } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!isObj(b) || !onlyKeys(b, TOP_KEYS)) return bad('shape');
  if (b.v !== 1) return bad('v');
  if (typeof b.installId !== 'string' || !UUID.test(b.installId)) return bad('installId');
  if (typeof b.version !== 'string' || !SEMVER.test(b.version)) return bad('version');
  if (typeof b.platform !== 'string' || !PLATFORMS.includes(b.platform)) return bad('platform');
  if (!count(b.projects)) return bad('projects');
  if (!Array.isArray(b.days) || b.days.length < 1 || b.days.length > 2) return bad('days');
  for (const d of b.days) {
    if (!isObj(d) || !onlyKeys(d, DAY_KEYS)) return bad('day shape');
    if (typeof d.day !== 'string' || !DAY.test(d.day)) return bad('day');
    if (Math.abs(Date.parse(`${d.day}T12:00:00Z`) - now.getTime()) > 2.5 * 86_400_000) return bad('day range');
    if (!count(d.threads) || !count(d.chatTurns) || !isObj(d.providers)) return bad('day counts');
    for (const [k, t] of Object.entries(d.providers)) {
      if (!(PROVIDERS as readonly string[]).includes(k)) return bad('provider');
      if (!isObj(t) || !onlyKeys(t, TOT_KEYS) || !TOT_KEYS.every((x) => count(t[x]))) return bad('totals');
    }
  }
  return { ok: true, ping: b as unknown as Ping };
}
