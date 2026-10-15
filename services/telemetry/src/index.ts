import { validatePing } from './validate';
import { computeStats, renderStats, type D1Like } from './stats';

interface Env { DB: D1Like }
const MAX_BYTES = 4096;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/v1/ping' && req.method === 'POST') {
        const raw = await req.text();
        if (raw.length > MAX_BYTES) return new Response(null, { status: 400 });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
        const now = new Date();
        const v = validatePing(body, now);
        if (!v.ok) return new Response(null, { status: 400 });
        const p = v.ping;
        for (const d of p.days) {
          await env.DB.prepare(`INSERT INTO pings (install_id, day, version, platform, providers, threads, chat_turns, projects, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(install_id, day) DO UPDATE SET version = excluded.version, platform = excluded.platform, providers = excluded.providers,
              threads = excluded.threads, chat_turns = excluded.chat_turns, projects = excluded.projects, received_at = excluded.received_at`)
            .bind(p.installId, d.day, p.version, p.platform, JSON.stringify(d.providers), d.threads, d.chatTurns, p.projects, now.toISOString()).run();
        }
        return new Response(null, { status: 204 });
      }
      // /stats* is guarded by Cloudflare Access at the edge; requests reach here only after login.
      if (req.method === 'GET' && url.pathname === '/stats.json') {
        return Response.json(await computeStats(env.DB, new Date()), { headers: { 'cache-control': 'no-store' } });
      }
      if (req.method === 'GET' && (url.pathname === '/stats' || url.pathname === '/stats/')) {
        return new Response(renderStats(await computeStats(env.DB, new Date())), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      return new Response('Not found', { status: 404 });
    } catch {
      return new Response(null, { status: url.pathname === '/v1/ping' ? 400 : 500 });
    }
  },
};
