import { startPtyTimingLoop } from '../sessions/status.js';
import { startAutoArchiveLoop } from '../sessions/auto-archive.js';
import { startInterimRecapLoop } from '../sessions/interim-recap.js';
import { startUpdateCheckLoop } from '../update/checker.js';
import { startTelemetryLoop } from '../telemetry/sender.js';
import type { DaemonServices } from './build.js';

/** One repeating job of the daemon. `start` begins it and returns the function that ends it. */
export interface DaemonTimer {
  name: string;
  /** True: the job calls another computer (GitHub, the telemetry host, a marketplace, the OS control plane). A build with `network: false` leaves it out. */
  network?: boolean;
  start(): () => void;
}

/**
 * Every repeating job of the daemon, in start order. This is the only list: a new interval goes here,
 * and `Daemon.stop()` ends each one. (The plugin workers keep the one schedule tick that is inside
 * plugins/workers.ts; `pluginWorkers.stop()` ends it.)
 */
export function daemonTimers(s: DaemonServices, opts: { network: boolean }): DaemonTimer[] {
  const all: DaemonTimer[] = [
    {
      // Keepalive: Cloudflare drops idle proxied WebSockets at ~100s. Ping clients
      // every 30s so terminal/events sockets survive quiet periods through the tunnel.
      name: 'ws-heartbeat',
      start: () => {
        const t = setInterval(() => {
          for (const wss of s.sockets.all) for (const client of wss.clients) if (client.readyState === client.OPEN) client.ping();
        }, 30_000);
        return () => clearInterval(t);
      },
    },
    // Watch the plugins folder: a changed plugin is announced without a restart.
    { name: 'plugin-watch', start: () => { s.plugins.start(); return () => s.plugins.stop(); } },
    {
      // Pull every marketplace on the updater's schedule (and once soon after boot); auto-updates apply then.
      name: 'marketplace-check', network: true,
      start: () => {
        const every = setInterval(() => { void s.installer.checkNow().catch(() => {}); }, 45 * 60 * 1000);
        every.unref?.();
        const first = setTimeout(() => { void s.installer.checkNow().catch(() => {}); }, 20_000);
        first.unref?.();
        return () => { clearInterval(every); clearTimeout(first); };
      },
    },
    // Parked threads: wake each one after its limit resets (limits/service.ts).
    { name: 'usage-limits', start: () => { s.usageLimits.start(); return () => s.usageLimits.stop(); } },
    // The usage gauge refreshes the figures of each account on its own tick (limits/gauge.ts).
    { name: 'usage-gauge', start: () => { s.usageGauge.start(); return () => s.usageGauge.stop(); } },
    // Per-box state projection for the OS control plane (design §4.4.5). Deliberately
    // not load-bearing for lifecycle — boxes are always-on, so a bad reading here
    // cannot stop a box mid-run.
    { name: 'box-heartbeat', network: true, start: () => { s.boxHeartbeat.start(); return () => s.boxHeartbeat.stop(); } },
    // PTY timing loop for Codex-style providers.
    { name: 'pty-timing', start: () => { const t = startPtyTimingLoop(s.db, s.ptyManager, s.broadcaster, undefined, s.statusService); return () => clearInterval(t); } },
    // Poll GitHub Releases for a newer version than what's running (immediately, then ~45 min).
    { name: 'update-check', network: true, start: () => { const t = startUpdateCheckLoop(s.db, s.broadcaster); return () => clearInterval(t); } },
    // Anonymous usage report: 60 s after boot, then an hourly check (Settings → About & updates switch).
    { name: 'telemetry', network: true, start: () => { const loop = startTelemetryLoop(s.db); return () => loop.stop(); } },
    {
      // The 30 s tick: due agent runs, then the stall watchdog (W1-D). The watchdog flags a working
      // thread that sent no frame for 10 minutes (DISPATCH_STALL_MINUTES). It only flags, and it has no timer of its own.
      name: 'scheduler-tick',
      start: () => {
        const t = setInterval(() => {
          try { s.agentService.processDueRuns(); } catch (err) { console.error(err); }
          try { s.stallWatchdog.tick(); } catch (err) { console.error('[stall] tick failed:', err); }
        }, 30_000);
        return () => clearInterval(t);
      },
    },
    // Auto-archive sweep — prunes opted-in threads that have gone idle past their
    // deadline. Cheap: a full scan of a small table (terminals) once a minute — no
    // index backs this, but the table stays small enough that it doesn't matter.
    { name: 'auto-archive', start: () => { const t = startAutoArchiveLoop(s.db, s.sessionService, s.broadcaster); return () => clearInterval(t); } },
    // Interim recap sweep (structured-recap spec, Unit 5): one notice to an overseer whose
    // agents still work 20 minutes after a busy Finished notice. The due time is in the DB.
    { name: 'interim-recap', start: () => { const t = startInterimRecapLoop(s.db, s.sessionService); return () => clearInterval(t); } },
  ];
  return opts.network ? all : all.filter((t) => !t.network);
}

/** Start each timer; the answer ends them all. A timer that fails to start is logged, and the others still start. */
export function startDaemonTimers(timers: DaemonTimer[]): () => void {
  const stops: (() => void)[] = [];
  for (const t of timers) {
    try { stops.push(t.start()); } catch (err) { console.error(`[timers] ${t.name} did not start:`, err); }
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const stop of stops.splice(0)) { try { stop(); } catch (err) { console.error('[timers] a timer did not stop:', err); } }
  };
}
