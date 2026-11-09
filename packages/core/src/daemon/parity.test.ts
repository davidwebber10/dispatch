// W3-A: the test build (createApp) and the production build are one function with different inputs.
// These tests fail when a route or a wire is added to one build and not to the other.
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { initSchema } from '../db/schema.js';
import { createApp } from '../server.js';
import { buildDaemon, NoopPTYManager, type Daemon } from './build.js';
import { SessionService } from '../sessions/service.js';
import { StatusService } from '../status/service.js';
import { AgentService } from '../agents/service.js';
import { PluginRegistry } from '../plugins/registry.js';
import { UsageLimitService } from '../limits/service.js';
import { AccountsStore } from '../auth/accounts.js';

const dirs: string[] = [];
const daemons: Daemon[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-parity-')); dirs.push(d); return d; };
const database = () => { const db = new Database(':memory:'); initSchema(db); return db; };
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of daemons.splice(0)) d.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const testBuild = (): Express => createApp({ db: database(), skipPty: true, secretsDir: tmp(), bundledDir: null });
/** What startServer builds, on a temp data dir. Nothing listens and no timer starts. */
function productionBuild(): Express {
  const dir = tmp();
  const d = buildDaemon({ db: database(), dataDir: dir, auth: 'gate', network: true, timers: false, bundledDir: null, pty: new NoopPTYManager(), port: 4131 });
  daemons.push(d);
  return d.app;
}

/** Every route of an Express app as `METHOD path`, in mount order. A router adds the pattern of its mount point. */
function routeTable(app: Express): string[] {
  const out: string[] = [];
  type Layer = { route?: { path: string; methods: Record<string, boolean> }; name: string; regexp: RegExp; handle: { stack?: Layer[] } };
  const walk = (stack: Layer[], prefix: string) => {
    for (const l of stack) {
      if (l.route) for (const m of Object.keys(l.route.methods)) out.push(`${m.toUpperCase()} ${prefix}${String(l.route.path)}`);
      else if (l.handle.stack) walk(l.handle.stack, prefix + l.regexp.source);
    }
  };
  walk((app as unknown as { _router: { stack: Layer[] } })._router.stack, '');
  return out;
}

describe('the test build and the production build', () => {
  test('the route table (method and path) of createApp equals the route table of the production build', () => {
    const t = routeTable(testBuild());
    const p = routeTable(productionBuild());
    expect(t.length).toBeGreaterThan(150);
    // The sign-in route belongs to the gate, and the test build has no gate. It is the one difference.
    expect(p.filter((r) => !t.includes(r))).toEqual(['POST /api/access/login']);
    expect(p.filter((r) => r !== 'POST /api/access/login')).toEqual(t);
    for (const must of ['/usage-limits/refresh', '/terminals/stalls', 'accounts', '/api/whoami', '/api/access/devices']) expect(t.some((r) => r.includes(must)), must).toBe(true);
  });

  test('every service that production wires into SessionService is also wired in the test build', () => {
    // Each wire is a call of a set*, register*, add* or on* method. Record which ones each build calls.
    const classes = { SessionService, StatusService, AgentService, PluginRegistry, UsageLimitService, AccountsStore };
    const wired = (build: () => unknown): string[] => {
      const spies: [string, { mock: { calls: unknown[] } }][] = [];
      for (const [cls, ctor] of Object.entries(classes)) {
        for (const name of Object.getOwnPropertyNames(ctor.prototype)) {
          if (!/^(set|register|add|on)[A-Z]/.test(name) || typeof (ctor.prototype as Record<string, unknown>)[name] !== 'function') continue;
          spies.push([`${cls}.${name}`, vi.spyOn(ctor.prototype as never, name as never) as never]);
        }
      }
      build();
      const called = spies.filter(([, s]) => s.mock.calls.length > 0).map(([n]) => n).sort();
      vi.restoreAllMocks();
      return called;
    };
    const t = wired(testBuild);
    const p = wired(productionBuild);
    // A fact of the daemon process, not a wire: the port that it will ask for. A test build has none, and
    // listening() sets the real one. (startServer itself sets the home folder of the overseer memory:
    // tests/sessions/overseer-memory-spawn.test.ts pins that line.)
    const PROCESS_FACTS = ['SessionService.setDaemonPort'];
    expect(p.filter((n) => !t.includes(n))).toEqual(PROCESS_FACTS);
    expect(t.filter((n) => !p.includes(n))).toEqual([]);
    // The list is not empty by accident: these wires were absent from createApp before W3-A.
    for (const must of [
      'SessionService.setUsageLimitService', 'SessionService.setWakeWorkingMarker', 'SessionService.setAccountEnv', 'SessionService.setAccountDirectory',
      'SessionService.setKeyRegistry', 'SessionService.setUserPromptListener', 'SessionService.setDeliveryOutbox', 'SessionService.setRestoredQuestions',
      'SessionService.registerStructuredManager', 'SessionService.setTerminalStatusWriter', 'SessionService.setLedgerChangeListener',
      'StatusService.addThreadSettledListener', 'StatusService.setHookListener', 'StatusService.onHarnessCommitted',
      'AgentService.setRoleRunner', 'AgentService.setLifecycleService',
      'PluginRegistry.setHookStatsProvider', 'PluginRegistry.setWorkerStatsProvider', 'PluginRegistry.setWorkerSync', 'PluginRegistry.setAssistTotalsProvider',
      'UsageLimitService.addChangeListener', 'UsageLimitService.addTouchListener', 'AccountsStore.onChange',
    ]) expect(t, must).toContain(must);
  });

  test('the named services of the two builds have the same fields', () => {
    const dir = tmp();
    const a = buildDaemon({ db: database(), dataDir: dir, auth: 'open', network: false, timers: false, bundledDir: null, pty: new NoopPTYManager() });
    const b = buildDaemon({ db: database(), dataDir: tmp(), auth: 'gate', network: true, timers: false, bundledDir: null, pty: new NoopPTYManager() });
    daemons.push(a, b);
    const present = (s: object) => Object.entries(s).filter(([, v]) => v !== undefined && v !== null).map(([k]) => k).sort();
    // The gate's own parts exist only with the gate. The model assist runs a CLI or calls OpenRouter: only with the network.
    const NOT_IN_A_TEST_BUILD = ['accessGate', 'assistRunner', 'devices', 'pairCodes'];
    expect(present(b.services).filter((k) => !NOT_IN_A_TEST_BUILD.includes(k))).toEqual(present(a.services));
    expect(present(b.services)).toEqual(expect.arrayContaining(NOT_IN_A_TEST_BUILD));
  });
});
