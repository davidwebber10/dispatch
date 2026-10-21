export interface D1Like { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown>; all<T>(): Promise<{ results: T[] }> } } }
export interface Stats {
  daily: { day: string; installs: number }[];
  versions: { version: string; installs: number }[];
  platforms: { platform: string; installs: number }[];
  providers: { day: string; provider: string; turns: number; output: number }[];
  totals: { installsEver: number; installs7d: number; turns30d: number; output30d: number };
}

const since = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

export async function computeStats(db: D1Like, now: Date): Promise<Stats> {
  const all = async <T>(sql: string, ...v: unknown[]) => (await db.prepare(sql).bind(...v).all<T>()).results;
  const d90 = since(now, 90), d30 = since(now, 30), d7 = since(now, 7);
  const daily = await all<{ day: string; installs: number }>('SELECT day, COUNT(*) AS installs FROM pings WHERE day >= ? GROUP BY day ORDER BY day', d90);
  // Latest version / platform per install over the last 7 days.
  const versions = await all<{ version: string; installs: number }>(
    'SELECT version, COUNT(*) AS installs FROM (SELECT install_id, version FROM pings p WHERE day >= ? AND day = (SELECT MAX(day) FROM pings q WHERE q.install_id = p.install_id)) GROUP BY version ORDER BY installs DESC', d7);
  const platforms = await all<{ platform: string; installs: number }>(
    'SELECT platform, COUNT(DISTINCT install_id) AS installs FROM pings WHERE day >= ? GROUP BY platform ORDER BY installs DESC', d7);
  const providers = await all<{ day: string; provider: string; turns: number; output: number }>(
    `SELECT p.day AS day, j.key AS provider, SUM(json_extract(j.value, '$.turns')) AS turns, SUM(json_extract(j.value, '$.output')) AS output
     FROM pings p, json_each(p.providers) j WHERE p.day >= ? GROUP BY p.day, j.key ORDER BY p.day, j.key`, d30);
  const [t] = await all<{ installsEver: number; installs7d: number }>(
    'SELECT COUNT(DISTINCT install_id) AS installsEver, COUNT(DISTINCT CASE WHEN day >= ? THEN install_id END) AS installs7d FROM pings', d7);
  const turns30d = providers.reduce((n, p) => n + p.turns, 0);
  const output30d = providers.reduce((n, p) => n + p.output, 0);
  return { daily, versions, platforms, providers, totals: { installsEver: t?.installsEver ?? 0, installs7d: t?.installs7d ?? 0, turns30d, output30d } };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number) => n.toLocaleString('en-US');

function bars(rows: { label: string; value: number }[]): string {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => `<div class="bar"><span class="l">${esc(r.label)}</span><span class="b" style="width:${(r.value / max) * 100}%"></span><span class="v">${fmt(r.value)}</span></div>`).join('');
}

export function renderStats(s: Stats): string {
  const byDayProvider = new Map<string, number>();
  for (const p of s.providers) byDayProvider.set(p.provider, (byDayProvider.get(p.provider) ?? 0) + p.output);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dispatch stats</title><style>
:root{--bg:#fafaf9;--fg:#1c1c1e;--mute:#6b6b70;--line:#e5e5e3;--bar:#2f9e5a}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececee;--mute:#8b8b92;--line:#26262b;--bar:#3ecf72}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:880px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 16px}h2{font-size:13px;color:var(--mute);text-transform:uppercase;letter-spacing:.06em;margin:28px 0 8px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.kpi{border:1px solid var(--line);border-radius:10px;padding:12px}.kpi b{display:block;font-size:22px}.kpi span{color:var(--mute);font-size:12px}
.bar{display:grid;grid-template-columns:110px 1fr 90px;align-items:center;gap:8px;margin:3px 0}.bar .b{height:10px;background:var(--bar);border-radius:3px;min-width:2px}.bar .l,.bar .v{font-variant-numeric:tabular-nums;font-size:12.5px}.bar .v{text-align:right;color:var(--mute)}
</style></head><body><main><h1>Dispatch stats</h1>
<div class="kpis"><div class="kpi"><b>${fmt(s.daily.at(-1)?.installs ?? 0)}</b><span>installs active, latest day</span></div>
<div class="kpi"><b>${fmt(s.totals.installs7d)}</b><span>installs active, 7 days</span></div>
<div class="kpi"><b>${fmt(s.totals.installsEver)}</b><span>installs ever</span></div>
<div class="kpi"><b>${fmt(s.totals.turns30d)}</b><span>turns, 30 days</span></div>
<div class="kpi"><b>${fmt(s.totals.output30d)}</b><span>output tokens, 30 days</span></div></div>
<h2>Daily active installs (90 days)</h2>${bars(s.daily.map((d) => ({ label: d.day, value: d.installs })))}
<h2>Versions (last 7 days)</h2>${bars(s.versions.map((v) => ({ label: v.version, value: v.installs })))}
<h2>Platforms (last 7 days)</h2>${bars(s.platforms.map((p) => ({ label: p.platform, value: p.installs })))}
<h2>Output tokens by provider (30 days)</h2>${bars([...byDayProvider].map(([label, value]) => ({ label, value })))}
</main></body></html>`;
}
