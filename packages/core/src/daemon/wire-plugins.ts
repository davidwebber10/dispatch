import path from 'path';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import * as pluginData from '../db/plugin-data.js';
import type { KeyRegistry } from '../auth/principals.js';
import { configurePluginFacts } from '../auth/plugin-facts.js';
import { PluginRegistry } from '../plugins/registry.js';
import { migratePreviews } from '../plugins/previews-migration.js';
import { ThreadEvents, isAutomatedThread } from '../plugins/thread-events.js';
import { PluginHooks } from '../plugins/hooks.js';
import { PluginWorkers } from '../plugins/workers.js';
import { MarketplaceService } from '../plugins/marketplaces.js';
import { PluginInstaller } from '../plugins/installer.js';
import { SkillsService } from '../plugins/skills.js';
import type { EventBroadcaster } from '../ws/events.js';

/** Scheduled and role-run threads are flagged in thread events (coach spec section 4.3). */
const automatedConfig = (config: string | null | undefined): boolean => { try { return isAutomatedThread(JSON.parse(config || '{}')); } catch { return false; } };

export interface PluginInputs {
  db: Database.Database;
  dataDir: string;
  /** The plugins folder. */
  pluginsDir: string;
  /** The bundled plugins folder; null for none. */
  bundledDir: string | null;
  broadcaster: EventBroadcaster;
  keys: KeyRegistry;
  runningVersion: string;
  logDir: string;
  /** The daemon's own address, for hook scripts and workers. '' until the daemon knows its port. */
  daemonApi: () => string;
  /** False: the workers keep no schedule tick of their own. */
  timers: boolean;
}

export interface PluginServices {
  plugins: PluginRegistry;
  marketplaces: MarketplaceService;
  installer: PluginInstaller;
  skills: SkillsService;
  threadEvents: ThreadEvents;
  pluginHooks: PluginHooks;
  pluginWorkers: PluginWorkers;
}

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md): the registry, marketplaces and installs,
 * skills, the thread events that plugins observe, hook scripts and workers. The folder watcher and the
 * marketplace check are timers (daemon/timers.ts); this function starts neither. It starts no worker
 * process either: `Daemon.listening()` does the first sync, when the workers can be told the daemon's address.
 */
export function wirePlugins(i: PluginInputs): PluginServices {
  const { db, dataDir, broadcaster } = i;
  const plugins = new PluginRegistry(i.pluginsDir, broadcaster, i.runningVersion, { keys: i.keys, keyDir: path.join(dataDir, 'keys'), bundledDir: i.bundledDir ?? undefined });
  configurePluginFacts((id) => plugins.facts(id));
  plugins.issueKeys();
  try { migratePreviews(db); } catch (e) { console.warn('[plugins] the previews migration failed; the daemon runs without it:', e instanceof Error ? e.message : e); }
  // Marketplaces and installs (spec section 7): the router reads them from app.locals.
  const marketplaces = new MarketplaceService(path.join(dataDir, 'marketplaces'), path.join(dataDir, 'marketplaces.json'));
  const installer = new PluginInstaller(plugins, marketplaces, i.pluginsDir, i.runningVersion, path.join(dataDir, 'installer.json'));
  const skills = new SkillsService(path.join(dataDir, 'skills'), path.join(dataDir, 'skills.json'), marketplaces);
  plugins.setAssistTotalsProvider((id) => pluginData.assistTotals(db, id));
  const threadEvents = new ThreadEvents(broadcaster, (id) => {
    const t = db.open ? terminalsDb.getById(db, id) : null;
    return t ? { sessionId: t.session_id, harness: t.type, automated: automatedConfig(t.config) } : null;
  });
  // Hook scripts run on thread events (spec section 3.3).
  const pluginHooks = new PluginHooks(plugins, threadEvents, { api: i.daemonApi });
  plugins.setHookStatsProvider((id) => pluginHooks.stats(id));
  // Workers (spec section 4): one process per enabled plugin with a worker, fed on stdin.
  const pluginWorkers = new PluginWorkers(plugins, threadEvents, { logDir: i.logDir, runDir: path.join(dataDir, 'run'), api: i.daemonApi, ...(i.timers ? {} : { tickMs: null }) });
  plugins.setWorkerStatsProvider((id) => pluginWorkers.stats(id));
  plugins.setWorkerSync(() => pluginWorkers.sync());
  return { plugins, marketplaces, installer, skills, threadEvents, pluginHooks, pluginWorkers };
}
