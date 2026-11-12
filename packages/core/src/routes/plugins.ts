import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import type Database from 'better-sqlite3';
import type { Router, RequestHandler, Request } from 'express';
import { policyRouter, publicRoute, ownerOnlyStrict, keyRoute, needs, type Rule } from '../auth/route-policy.js';
import { principalOf, scopeOf } from '../auth/request-principal.js';
import * as pluginData from '../db/plugin-data.js';
import { projectListRule, allowRule } from '../auth/key-rules.js';
import { setFileHeaders, HTML_SANDBOX_CSP } from '../http/active-content.js';
import { IMMUTABLE, pickEncoding } from '../web-assets.js';
import { insideRealRoot } from '../files/confine.js';
import { createThumbnailer, thumbnailHeaders, type Thumbnailer } from '../files/thumbnail.js';
import { defaultSecretRoots, holdsSecret, SECRET_PATH_ERROR, type SecretRoots } from '../files/secret-paths.js';
import { platform } from '../platform/index.js';
import * as sessionsDb from '../db/sessions.js';
import { PATH_REFUSALS } from '../files/path-policy.js';
import { pathPolicyFor } from '../files/path-policy-default.js';
import { checkProjectFile, ProjectFileError, PROJECT_FILE_MIME } from '../plugins/files.js';
import { SNAPSHOT_MAX_BYTES, takeSnapshot, snapshotPath, removeSnapshot, removeAllSnapshots } from '../plugins/snapshots.js';
import type { PluginRegistry } from '../plugins/registry.js';
import { ASSIST_HARNESSES, ASSIST_CLAUDE_MODEL, ASSIST_OPENROUTER_MODEL, type AssistRunner, type AssistHarness, type AssistResult } from '../assist/run.js';
import { notionalValueUsd } from '../analytics/pricing.js';
import { estimateShare, tokenWeight, FIVE_HOUR_FLOOR_PERCENT, WEEKLY_TOKENS_PER_PERCENT } from '../plugins/assist-share.js';
import type { UsageSummary } from '../limits/gauge.js';
import type { PluginWorkers } from '../plugins/workers.js';
import type { MarketplaceService } from '../plugins/marketplaces.js';
import type { PluginInstaller } from '../plugins/installer.js';
import type { SkillsService } from '../plugins/skills.js';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md): the manifests, the owner's
 * actions on local plugins, and the plugin files the web client imports.
 */
function fail(res: import('express').Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const status = msg === 'unknown plugin' ? 404 : msg === 'exists' ? 409 : msg === 'bad id' || msg === 'not local' || msg === 'bundled' ? 400 : 500;
  res.status(status).json({ error: msg });
}

const OK = { ok: true } as const;
/** A snapshot never changes (Drops, 2026-11-11): its bytes and its thumbnails may be kept for a year. */
const SNAPSHOT_CACHE = 'private, max-age=31536000, immutable';
export const ASSIST_INFLIGHT_MAX = 3;
/** A plugin sends at most one push in this time (coach plan, Task 5). */
export const PUSH_GAP_MS = 3_600_000;
/** A model or account id a caller may name: no spaces, at most 120 characters. */
const ASSIST_ID_RE = /^[^\s]{1,120}$/;

/** A plugin key reaches the storage and settings of its own plugin only. */
const ownPluginRule: Rule = (req, ctx) => (ctx.plugin?.id === req.params.id
  ? OK
  : { ok: false, status: 403, error: 'out_of_scope', message: 'A plugin reaches its own storage only.' });

/** A thread reaches a plugin's documents only when the plugin granted threads that access (spec section 5). */
function grantRule(plugins: PluginRegistry, kind: 'read' | 'write' | 'call-worker'): Rule {
  const permission = kind === 'call-worker' ? 'threads:call-worker' : `threads:${kind}-storage`;
  const what = kind === 'call-worker' ? 'call its worker' : `${kind} its storage`;
  return (req) => {
    const facts = plugins.facts(req.params.id);
    // A disabled or broken plugin granted nothing: its documents stay closed to every thread.
    if (!facts) return { ok: false, status: 404, error: 'out_of_scope', message: 'unknown plugin' };
    return facts.permissions.includes(permission)
      ? OK
      : { ok: false, status: 403, error: 'out_of_scope', message: `The plugin "${req.params.id}" does not let threads ${what}.` };
  };
}

/** Who is calling, for the worker: the owner, a thread, or a plugin (never the credential itself). */
function principalHeaders(req: Request): Record<string, string> {
  let p;
  try { p = principalOf(req); } catch { return { 'x-dispatch-principal': 'owner' }; }
  if (p.kind === 'thread') {
    const c = scopeOf(req).caller(p.terminalId);
    return { 'x-dispatch-principal': `thread:${p.terminalId}`, ...(c?.sessionId ? { 'x-dispatch-session': c.sessionId } : {}) };
  }
  if (p.kind === 'plugin') return { 'x-dispatch-principal': `plugin:${p.pluginId}` };
  return { 'x-dispatch-principal': 'owner' };
}

/** Headers that never cross to the worker: the caller's credentials and the hop-by-hop set. */
const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'host', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'x-dispatch-principal', 'x-dispatch-session']);

/**
 * The price an OpenRouter call with no reported cost and an unknown model is metered at, in dollars
 * per million tokens: high on purpose (Opus list price), so the dollar budget fills early, never late.
 */
export const ESTIMATE_PRICE = Object.freeze({ input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 });

/** One assist answer as a meter row: the harness's cost, else priced from the tokens when the model is known. */
function meterOf(result: AssistResult, asked: string, started: number, account?: string): pluginData.AssistRecord {
  const u = result.usage;
  const cacheReadTokens = u.cacheReadTokens ?? 0;
  const cacheCreateTokens = u.cacheCreateTokens ?? 0;
  let costUsd = typeof result.costUsd === 'number' ? result.costUsd
    : notionalValueUsd({ model: result.model, input: u.inputTokens, output: u.outputTokens, cacheRead: cacheReadTokens, cacheCreate: cacheCreateTokens });
  // OpenRouter's cap is dollars: a call with no cost must still count, at a conservative estimate.
  let costEstimated = false;
  if (costUsd === null && (result.harness ?? asked) === 'openrouter') {
    costUsd = (u.inputTokens * ESTIMATE_PRICE.input + u.outputTokens * ESTIMATE_PRICE.output + cacheReadTokens * ESTIMATE_PRICE.cacheRead + cacheCreateTokens * ESTIMATE_PRICE.cacheCreate) / 1e6;
    costEstimated = true;
  }
  return {
    // The account that ran: the answer's, else the one the route resolved (never for OpenRouter, which has none).
    model: result.model, harness: result.harness ?? asked, accountId: result.accountId ?? (result.harness === 'openrouter' ? null : account ?? null),
    inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens, cacheCreateTokens,
    costUsd, ...(costEstimated ? { costEstimated } : {}), ms: typeof result.ms === 'number' ? result.ms : Date.now() - started, ok: true,
  };
}

const DAY_MS = 86_400_000;

/** The default model a harness runs when the caller names none, to price a reservation. */
const DEFAULT_MODEL: Record<AssistHarness, string> = { claude: ASSIST_CLAUDE_MODEL, codex: 'gpt-5.6-terra', openrouter: ASSIST_OPENROUTER_MODEL };
interface Reservation { harness: AssistHarness; accountId: string; weight: number; usd: number; tokens: number }
interface BudgetCheck { refuse: Record<string, unknown> | null; headers: Record<string, string>; release: () => void }
const pct = (n: number): string => String(Math.round(n * 10_000) / 10_000);

/**
 * The budget guard (coach spec sections 4.5, 7.4, 9a.2-3). A plugin with a budget is refused
 * (429 `budget`) when its estimated weekly share of the account the call runs on, plus the calls
 * it has in flight, reaches its cap; or when that account's 5-hour window is at 90% or more.
 * OpenRouter has no limit windows: its cap is dollars over the last 7 days. A call in flight is
 * reserved at its prompt (about 4 characters a token) and its maxTokens of output, at the model's
 * price, until it ends; then the metered row takes its place. No budget = no cap.
 *
 * Fail safe: with a percent budget but no weekly figure for the account (no usage data yet, a poll
 * gap), the cap becomes tokens: `percentWeekly` x `WEEKLY_TOKENS_PER_PERCENT` (or `tokensPerPercent`)
 * over the plugin's subscription calls of the last 7 days (429 `budget`, window `unknown`).
 */
function createBudgetGuard(db: Database.Database, limits: AssistLimitsDeps, budgetOf: (pluginId: string) => pluginData.PluginBudget) {
  const reserved = new Map<string, Set<Reservation>>();
  /** The fail-safe token cap for a percent budget with no weekly figure: the plugin's 7-day tokens and the calls in flight. */
  const tokenFallback = (pluginId: string, percentWeekly: number): { usedTokens: number; capTokens: number } => {
    const capTokens = Math.round(percentWeekly * (limits.tokensPerPercent ?? WEEKLY_TOKENS_PER_PERCENT));
    const inFlight = [...(reserved.get(pluginId) ?? [])].filter((r) => r.harness !== 'openrouter').reduce((n, r) => n + r.tokens, 0);
    return { usedTokens: pluginData.assistTokensSince(db, pluginId, new Date(Date.now() - 7 * DAY_MS).toISOString()) + inFlight, capTokens };
  };
  return {
    tokenFallback,
    check(pluginId: string, call: { harness: AssistHarness | 'auto' | undefined; accountId: string | undefined; model: string | undefined; maxTokens: number; promptChars: number }): BudgetCheck {
      const harness: AssistHarness = call.harness === 'codex' || call.harness === 'openrouter' ? call.harness : 'claude';
      const sub: 'claude' | 'codex' = harness === 'codex' ? 'codex' : 'claude';
      const accountId = harness === 'openrouter' ? 'openrouter' : call.accountId ?? limits.defaultAccount?.(sub) ?? 'cli';
      const budget = budgetOf(pluginId);
      const mine = reserved.get(pluginId) ?? new Set<Reservation>();
      const same = [...mine].filter((r) => r.harness === harness && r.accountId === accountId);
      const weight = tokenWeight(call.model ?? DEFAULT_MODEL[harness], { input: Math.ceil(call.promptChars / 4), output: call.maxTokens });
      const tokens = Math.ceil(call.promptChars / 4) + call.maxTokens;
      const headers: Record<string, string> = {};
      let refuse: Record<string, unknown> | null = null;

      if (harness === 'openrouter') {
        const spent = pluginData.assistCostSince(db, pluginId, 'openrouter', new Date(Date.now() - 7 * DAY_MS).toISOString()) + same.reduce((n, r) => n + r.usd, 0);
        headers['X-Budget-Used-Usd'] = pct(spent);
        if (budget.usdWeekly !== null) {
          headers['X-Budget-Cap-Usd'] = String(budget.usdWeekly);
          if (spent >= budget.usdWeekly) refuse = { error: 'budget', usedUsd: spent, capUsd: budget.usdWeekly, message: `The plugin has spent its $${budget.usdWeekly} a week on OpenRouter.` };
        }
      } else {
        const summary = (() => { try { return limits.summary?.() ?? null; } catch { return null; } })();
        const opts = { pluginId, accountId, harness, defaultAccountId: limits.defaultAccount?.(sub) ?? 'cli' };
        const week = estimateShare(db, summary, { ...opts, window: 'seven_day' });
        if (week) {
          const reservedW = same.reduce((n, r) => n + r.weight, 0);
          const used = week.pluginPercent + (week.accountWeight > 0 ? (reservedW / week.accountWeight) * week.usedPercent : 0);
          headers['X-Budget-Used-Percent'] = pct(used);
          if (week.resetsAt) headers['X-Budget-Resets-At'] = week.resetsAt;
          if (budget.percentWeekly !== null && used >= budget.percentWeekly) {
            refuse = { error: 'budget', window: 'seven_day', usedPercent: used, capPercent: budget.percentWeekly, message: `The plugin has used its ${budget.percentWeekly}% of the weekly limit.` };
          }
        } else if (budget.percentWeekly !== null) {
          // No weekly figure: never unlimited. The plugin's tokens over 7 days, with the calls in flight.
          const { usedTokens: usedT, capTokens: cap } = tokenFallback(pluginId, budget.percentWeekly);
          headers['X-Budget-Used-Tokens'] = String(usedT);
          headers['X-Budget-Cap-Tokens'] = String(cap);
          if (usedT >= cap) refuse = { error: 'budget', window: 'unknown', usedTokens: usedT, capTokens: cap, message: `The usage figures for this account are unknown, so the plugin is held to ${cap} tokens a week; it has used them.` };
        }
        if (budget.percentWeekly !== null) {
          headers['X-Budget-Cap-Percent'] = String(budget.percentWeekly);
          // Never take the last 10% of a 5-hour window (section 9a.2).
          const five = estimateShare(db, summary, { ...opts, window: 'five_hour' });
          if (!refuse && five && five.usedPercent >= FIVE_HOUR_FLOOR_PERCENT) {
            refuse = { error: 'budget', window: 'five_hour', usedPercent: five.usedPercent, capPercent: FIVE_HOUR_FLOOR_PERCENT, message: 'The account is at 90% of its 5-hour limit; assist waits for the reset.' };
          }
        }
      }
      if (refuse) return { refuse, headers, release: () => {} };
      const r: Reservation = { harness, accountId, weight, usd: weight / 1e6, tokens };
      mine.add(r); reserved.set(pluginId, mine);
      return { refuse: null, headers, release: () => { mine.delete(r); if (mine.size === 0) reserved.delete(pluginId); } };
    },
  };
}
/** A `from`/`to` query as ISO times: `from` defaults to 7 days ago, `to` to now (+1 minute). Null when one does not parse. */
export function rangeOf(from: unknown, to: unknown, now = Date.now()): { from: string; to: string } | null {
  const parse = (v: unknown, fallback: number): number | null => {
    if (v === undefined || v === '') return fallback;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };
  const f = parse(from, now - 7 * DAY_MS);
  const t = parse(to, now + 60_000);
  if (f === null || t === null) return null;
  return { from: new Date(f).toISOString(), to: new Date(t).toISOString() };
}

/** The writer stamped on a document a thread key writes: from the key, never from the body. */
function writerOf(req: Request): pluginData.Writer | null {
  let p;
  try { p = principalOf(req); } catch { return null; }
  if (p.kind !== 'thread') return null;
  const c = scopeOf(req).caller(p.terminalId);
  return { terminalId: p.terminalId, sessionId: c?.sessionId ?? '', label: c?.label ?? null };
}

function storageError(res: import('express').Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === 'too large') return void res.status(413).json({ error: 'too_large', message: `A document is at most ${pluginData.DOC_MAX_BYTES} bytes.` });
  if (msg === 'too many') return void res.status(409).json({ error: 'too_many', message: `A plugin holds at most ${pluginData.DOCS_MAX} documents.` });
  if (msg === 'bad key') return void res.status(400).json({ error: 'bad_key', message: 'A key is letters, digits, dots, dashes, underscores and colons, up to 128.' });
  res.status(500).json({ error: msg });
}

/** What the assist routes read beyond the runner: the usage summary and each harness's default account. */
export interface AssistLimitsDeps {
  /** The usage gauge's summary (`/usage-limits/summary`); absent = no limit figures. */
  summary?: () => UsageSummary | null;
  /** A harness's default account (accounts.json); `cli` when absent. */
  defaultAccount?: (harness: 'claude' | 'codex') => string;
  /** The fail-safe token cap per budget percent when a weekly figure is unknown. Default WEEKLY_TOKENS_PER_PERCENT. */
  tokensPerPercent?: number;
  /** Whether an account id exists for a harness (accounts.json). Absent: only the default account is known. */
  hasAccount?: (harness: 'claude' | 'codex', id: string) => boolean;
  /** Small copies of images for `?thumb=` (2026-11-09). Default: a cache in the data folder. */
  thumbs?: Thumbnailer;
  /** The credential deny-list of the file route (files/secret-paths.ts). Default: the roots of this machine. */
  secretRoots?: SecretRoots;
  /** The data folder: the snapshots of plugin files and the thumbnail cache live in it. Default: platform.dataDir(). */
  dataDir?: string;
  /** The web-push sender, for `notify:push` (coach spec section 9a.5). */
  push?: { notifyPlugin(input: { pluginId: string; title: string; body: string; url?: string }): Promise<void> };
}

export function createPluginsRouter(plugins: PluginRegistry, db: Database.Database, assist: AssistRunner | null = null, limits: AssistLimitsDeps = {}): Router {
  const router = policyRouter();
  // Created on first use, so a test app that never asks for a thumbnail never touches the data folder.
  const dataDir = (): string => limits.dataDir ?? platform.dataDir();
  let thumbs: Thumbnailer | null = limits.thumbs ?? null;
  const thumbnailer = (): Thumbnailer => (thumbs ??= createThumbnailer({ cacheDir: path.join(dataDir(), 'cache', 'thumbs') }));
  // Read on first use too: a router that serves no file never looks at the data folder.
  let roots: SecretRoots | null = limits.secretRoots ?? null;
  const secretRoots = (): SecretRoots => (roots ??= defaultSecretRoots(dataDir()));
  // Which folders a project file may be in (files/path-policy.ts), as for every route that takes a path.
  const filePolicy = pathPolicyFor(db);
  const knownAccount = (h: 'claude' | 'codex', id: string): boolean => (limits.hasAccount ? limits.hasAccount(h, id) : id === (limits.defaultAccount?.(h) ?? 'cli'));

  // The list is for the owner and for any thread key (a thread may ask what plugins exist).
  router.get('/plugins', keyRoute({ thread: projectListRule, roleRun: projectListRule, plugin: allowRule }), (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ plugins: plugins.list() });
  });

  router.post('/plugins/scaffold', ownerOnlyStrict, (req, res) => {
    const { id, name } = (req.body ?? {}) as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || typeof name !== 'string' || !name.trim()) return void res.status(400).json({ error: 'id and name are required' });
    try { res.status(201).json(plugins.scaffold(id, name.trim())); } catch (e) { fail(res, e); }
  });

  router.post('/plugins/:id/enable', ownerOnlyStrict, (req, res) => {
    try { const row = plugins.setEnabled(req.params.id, true); plugins.announce(row.id); res.json(row); } catch (e) { fail(res, e); }
  });

  router.post('/plugins/:id/disable', ownerOnlyStrict, (req, res) => {
    try { const row = plugins.setEnabled(req.params.id, false); plugins.announce(row.id); res.json(row); } catch (e) { fail(res, e); }
  });

  router.post('/plugins/:id/reload', ownerOnlyStrict, (req, res) => {
    const row = plugins.get(req.params.id);
    if (!row) return void res.status(404).json({ error: 'unknown plugin' });
    plugins.announce(row.id);
    res.json(row);
  });

  // Copy a bundled (or local) plugin to a new local id: the way to change a bundled one (spec section 10).
  router.post('/plugins/:id/copy', ownerOnlyStrict, (req, res) => {
    const { id } = (req.body ?? {}) as { id?: unknown };
    if (typeof id !== 'string') return void res.status(400).json({ error: 'bad id' });
    try { const row = plugins.copyToLocal(req.params.id, id); plugins.announce(row.id); res.status(201).json(row); } catch (e) { fail(res, e); }
  });

  router.delete('/plugins/:id', ownerOnlyStrict, (req, res) => {
    // ?keepData=1 keeps the plugin's documents, settings and files, so a reinstall finds them (owner, 2026-11-07).
    try {
      plugins.remove(req.params.id);
      if (req.query.keepData !== '1') { pluginData.clearPlugin(db, req.params.id); removeAllSnapshots(dataDir(), req.params.id); }
      plugins.announce(req.params.id); res.status(204).end();
    } catch (e) { fail(res, e); }
  });

  // ── a bound caller reaches its own plugin only (engineering program 2026-11-09, W3-F) ──
  // The narrow SDK names the plugin it is bound to in X-Dispatch-Plugin-Bound. A plugin's web bundle
  // runs in the owner's session, so no key tells the daemon which plugin asked; this header does.
  // A request that carries it and names another plugin in its path is refused before any rule or
  // handler runs. The check is a guard against a wrong or forged path through the SDK, not a sandbox:
  // code in the owner's page can send a request with no such header. X-Dispatch-Plugin alone (the
  // version 1 SDK) stays a log tag.
  const boundRefusals = new Set<string>();
  router.param('id', (req, res, next, id: string) => {
    const header = req.headers['x-dispatch-plugin-bound'];
    if (header === undefined || !req.path.startsWith('/plugins/')) return void next();
    const boundTo = Array.isArray(header) ? header.join(',') : header;
    if (boundTo === id) return void next();
    const pair = `${boundTo.slice(0, 64)}|${id}`;
    if (!boundRefusals.has(pair)) {
      if (boundRefusals.size > 500) boundRefusals.clear();
      boundRefusals.add(pair);
      console.log(`[plugins] refused ${req.method} ${req.path.replace(/[^\x20-\x7e]/g, '?')}: the request is bound to plugin ${JSON.stringify(boundTo.slice(0, 64))} and names ${JSON.stringify(id)}`);
    }
    res.status(403).json({ error: 'out_of_scope', message: 'A plugin reaches its own routes only.' });
  });

  // ── storage and settings (spec section 5) ──────────────────────────────────────────────
  const known = (req: Request, res: import('express').Response): boolean => {
    if (plugins.get(req.params.id)) return true;
    res.status(404).json({ error: 'unknown plugin' });
    return false;
  };
  const dataRead = keyRoute({ plugin: ownPluginRule, thread: grantRule(plugins, 'read'), roleRun: grantRule(plugins, 'read') });
  const dataWrite = keyRoute({ plugin: ownPluginRule, thread: grantRule(plugins, 'write'), roleRun: grantRule(plugins, 'write') });
  const settingsRule = keyRoute({ plugin: ownPluginRule });

  router.get('/plugins/:id/data', dataRead, (req, res) => {
    if (!known(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ docs: req.query.values === '1' ? pluginData.listDocs(db, req.params.id, { values: true }) : pluginData.listDocs(db, req.params.id) });
  });

  router.get('/plugins/:id/data/:key', dataRead, (req, res) => {
    if (!known(req, res)) return;
    const doc = pluginData.getDoc(db, req.params.id, req.params.key);
    if (!doc) return void res.status(404).json({ error: 'document not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(doc);
  });

  // The body is `{ value }`: any JSON value, including a string or a number.
  router.put('/plugins/:id/data/:key', dataWrite, (req, res) => {
    if (!known(req, res)) return;
    const body = req.body as { value?: unknown } | undefined;
    if (!body || typeof body !== 'object' || !('value' in body)) return void res.status(400).json({ error: 'bad_body', message: 'Send { "value": ... }.' });
    try {
      const doc = pluginData.setDoc(db, req.params.id, req.params.key, body.value, writerOf(req));
      plugins.broadcast({ type: 'plugin:data', id: req.params.id, key: req.params.key });
      res.json(doc);
    } catch (e) { storageError(res, e); }
  });

  router.delete('/plugins/:id/data/:key', dataWrite, (req, res) => {
    if (!known(req, res)) return;
    if (!pluginData.deleteDoc(db, req.params.id, req.params.key)) return void res.status(404).json({ error: 'document not found' });
    plugins.broadcast({ type: 'plugin:data', id: req.params.id, key: req.params.key, deleted: true });
    res.status(204).end();
  });

  router.get('/plugins/:id/settings', settingsRule, (req, res) => {
    if (!known(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(pluginData.getSettings(db, req.params.id) ?? { value: null, updatedAt: null });
  });

  router.put('/plugins/:id/settings', settingsRule, (req, res) => {
    if (!known(req, res)) return;
    const body = req.body as { value?: unknown } | undefined;
    if (!body || typeof body !== 'object' || !('value' in body)) return void res.status(400).json({ error: 'bad_body', message: 'Send { "value": ... }.' });
    try {
      const out = pluginData.setSettings(db, req.params.id, body.value);
      plugins.broadcast({ type: 'plugin:settings', id: req.params.id });
      res.json(out);
    } catch (e) { storageError(res, e); }
  });

  // ── file references (spec section 5): a checked file of a project, served to the owner ──
  // A thread registers a file of its own project (the plugin must grant threads:write-storage);
  // the owner or the plugin's own key names the project in the body.
  router.post('/plugins/:id/files', dataWrite, async (req, res) => {
    if (!known(req, res)) return;
    const body = (req.body ?? {}) as { path?: unknown; sessionId?: unknown };
    let principal: ReturnType<typeof principalOf> | null = null;
    try { principal = principalOf(req); } catch { principal = null; }
    let sessionId: string | null = null;
    if (principal?.kind === 'thread') {
      sessionId = scopeOf(req).caller(principal.terminalId)?.sessionId ?? null;
      if (!sessionId) return void res.status(400).json({ error: 'bad_body', message: 'The thread has no project.' });
    } else {
      if (typeof body.sessionId !== 'string' || !body.sessionId) return void res.status(400).json({ error: 'bad_body', message: 'Send { path, sessionId }.' });
      sessionId = body.sessionId;
    }
    const session = sessionsDb.getById(db, sessionId);
    if (!session) return void res.status(404).json({ error: 'session not found' });
    let ref: pluginData.PluginFile;
    try {
      const checked = checkProjectFile(session.working_dir, body.path);
      const why = filePolicy.problem(checked.path, { project: session.working_dir, use: 'read' })
        ?? filePolicy.openedProblem(fs.statSync(checked.path), fs.realpathSync(checked.path));
      if (why) return void res.status(403).json({ error: PATH_REFUSALS[why], code: 'path_refused', reason: why });
      ref = pluginData.addFile(db, req.params.id, session.id, checked);
    } catch (e) {
      if (e instanceof ProjectFileError) return void res.status(e.status).json({ error: e.message });
      return void res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); // an async handler: Express 4 would not catch a throw
    }
    // Drops (2026-11-11): a snapshot of the checked file, served from now on (plugins/snapshots.ts). No copy
    // (too large, a credential, an error) keeps the reference to the project file, as before.
    if (ref.size <= SNAPSHOT_MAX_BYTES) {
      const name = await takeSnapshot({ dataDir: dataDir(), pluginId: req.params.id, fileId: ref.fileId, src: ref.path, root: session.working_dir, roots: secretRoots() }).catch(() => null);
      if (name) {
        pluginData.setFileSnapshot(db, req.params.id, ref.fileId, name);
        // The list's small copy is made now, so the first look on a phone does not wait for it. Not awaited.
        const snap = snapshotPath(dataDir(), req.params.id, name);
        if (snap && ref.mime.startsWith('image/') && ref.mime !== 'image/svg+xml') void thumbnailer().thumbnail(snap, 480).catch(() => null);
      }
    }
    res.status(201).json(ref);
  });

  // The bytes, for the owner only. Re-checked against the project's CURRENT folder: a project moved
  // since the post, or a file replaced by a symlink, must not turn this into a read outside it.
  router.get('/plugins/:id/files/:fileId', async (req, res) => {
    if (!known(req, res)) return;
    const file = pluginData.getFile(db, req.params.id, req.params.fileId);
    // Drops (2026-11-11): a snapshot was checked when it was made and never changes. It is served without the
    // project (which may have moved since), and with a cache of a year. A recorded copy that is gone from the
    // disk falls back to the project file below, with all of its checks.
    const snap = file ? snapshotPath(dataDir(), req.params.id, pluginData.getFileSnapshot(db, req.params.id, file.fileId)) : null;
    if (file && snap && fs.existsSync(snap)) {
      const mime = PROJECT_FILE_MIME[path.extname(snap).toLowerCase()] ?? 'application/octet-stream';
      const width = Number(req.query.thumb);
      if (req.query.thumb !== undefined && mime.startsWith('image/') && mime !== 'image/svg+xml' && Number.isInteger(width)) {
        const small = await thumbnailer().thumbnail(snap, width).catch(() => null);
        if (small) {
          res.set({ 'Cache-Control': SNAPSHOT_CACHE, ETag: `"snap-${file.fileId}-${width}"` });
          setFileHeaders(res, 'image/jpeg', 'sandbox');
          res.type('image/jpeg');
          return void res.sendFile(small);
        }
      }
      res.set({ 'Cache-Control': SNAPSHOT_CACHE, ETag: `"snap-${file.fileId}"` });
      res.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}"`);
      setFileHeaders(res, mime, mime === 'text/html' ? HTML_SANDBOX_CSP : 'sandbox');
      res.type(mime);
      return void res.sendFile(snap);
    }
    const session = file ? sessionsDb.getById(db, file.sessionId) : null;
    if (!file || !session || !insideRealRoot(session.working_dir, file.path) || !fs.existsSync(file.path)) {
      return void res.status(404).json({ error: 'file not found' });
    }
    // Credentials are never served, to any caller (v4.5.0 review, I4): a project whose folder is the home folder
    // or the data folder, or a hard link in a project to a secret file. The check is before the thumbnail, so no
    // small copy of such a file is made either. An error of the check refuses the file.
    if (await holdsSecret(file.path, secretRoots()).catch(() => true)) return void res.status(403).json({ error: SECRET_PATH_ERROR });
    {
      let why = filePolicy.problem(file.path, { project: session.working_dir, use: 'read' });
      try { why ??= filePolicy.openedProblem(fs.statSync(file.path), fs.realpathSync(file.path)); } catch { /* gone: sendFile answers */ }
      if (why) return void res.status(403).json({ error: PATH_REFUSALS[why], code: 'path_refused', reason: why });
    }
    const mime = PROJECT_FILE_MIME[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream';
    // `?thumb=<width>` (2026-11-09): a list's small copy of an image. Anything that cannot be made small
    // (not an image, a width that is not offered, a broken file, no resizer) gets the original below.
    const width = Number(req.query.thumb);
    if (req.query.thumb !== undefined && mime.startsWith('image/') && mime !== 'image/svg+xml' && Number.isInteger(width)) {
      const small = await thumbnailer().thumbnail(file.path, width).catch(() => null);
      if (small) {
        res.set(thumbnailHeaders(small));
        setFileHeaders(res, 'image/jpeg', 'sandbox');
        res.type('image/jpeg');
        return void res.sendFile(small);
      }
    }
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}"`);
    // HTML runs scripts in an opaque origin; SVG and other markup get the plain sandbox (no scripts at all).
    setFileHeaders(res, mime, mime === 'text/html' ? HTML_SANDBOX_CSP : 'sandbox');
    res.type(mime);
    res.sendFile(file.path);
  });

  router.delete('/plugins/:id/files/:fileId', settingsRule, (req, res) => {
    if (!known(req, res)) return;
    const snapshot = pluginData.getFileSnapshot(db, req.params.id, req.params.fileId);
    if (!pluginData.removeFile(db, req.params.id, req.params.fileId)) return void res.status(404).json({ error: 'file not found' });
    removeSnapshot(dataDir(), req.params.id, snapshot);
    res.status(204).end();
  });

  // ── export and import (owner, 2026-11-07) ──────────────────────────────────────────────
  // Both work for a removed plugin whose data was kept (DELETE ?keepData=1): the rows are the subject,
  // not the folder. 404 only when no such plugin is installed and nothing is stored under its id.
  const knownOrStored = (req: Request, res: import('express').Response): boolean => {
    if (plugins.get(req.params.id) || pluginData.hasData(db, req.params.id)) return true;
    res.status(404).json({ error: 'unknown plugin' });
    return false;
  };

  router.get('/plugins/:id/export', ownerOnlyStrict, (req, res) => {
    if (!knownOrStored(req, res)) return;
    const out = pluginData.exportPlugin(db, req.params.id);
    const safeId = req.params.id.replace(/[^A-Za-z0-9._-]+/g, '_');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${safeId}-data-${out.exportedAt.slice(0, 10)}.json"`);
    res.type('application/json').send(JSON.stringify(out, null, 2));
  });

  router.post('/plugins/:id/import', ownerOnlyStrict, (req, res) => {
    if (!knownOrStored(req, res)) return;
    const mode = req.query.mode === undefined ? 'merge' : req.query.mode;
    if (mode !== 'merge' && mode !== 'replace') return void res.status(400).json({ error: 'bad_mode', message: 'mode is merge or replace.' });
    const id = req.params.id;
    const before = mode === 'replace' ? pluginData.listDocs(db, id).map((d) => d.key) : [];
    try {
      const out = pluginData.importPlugin(db, id, req.body, { mode, force: req.query.force === '1' });
      if (mode === 'replace') removeAllSnapshots(dataDir(), id); // the rows that held them are gone
      const now = new Set(pluginData.listDocs(db, id).map((d) => d.key));
      for (const key of before) if (!now.has(key)) plugins.broadcast({ type: 'plugin:data', id, key, deleted: true });
      for (const key of now) plugins.broadcast({ type: 'plugin:data', id, key });
      plugins.broadcast({ type: 'plugin:settings', id });
      res.json(out);
    } catch (e) {
      if (e instanceof pluginData.ImportError) return void res.status(e.status).json({ error: e.code, message: e.message });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── marketplaces and installs (spec section 7): owner-only ───────────────────────────────
  const skillsOf = (req: Request): SkillsService | null => (req.app.locals.skills as SkillsService | undefined) ?? null;
  const marketsOf = (req: Request): MarketplaceService | null => (req.app.locals.marketplaces as MarketplaceService | undefined) ?? null;
  const installerOf = (req: Request): PluginInstaller | null => (req.app.locals.installer as PluginInstaller | undefined) ?? null;
  const installError = (res: import('express').Response, e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /unknown marketplace|not in the marketplace|no version|no longer in/.test(msg) ? 404
      : /already installed|bundled plugin|local plugin .* exists|nothing to roll back|marketplace of this plugin is gone/.test(msg) ? 409
      : /not an installed plugin|bad id|needs Dispatch|needs SDK|not a marketplace url/.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  };

  router.get('/plugins/marketplaces', ownerOnlyStrict, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ marketplaces: marketsOf(req)?.list() ?? [] });
  });
  router.post('/plugins/marketplaces', ownerOnlyStrict, async (req, res) => {
    const m = marketsOf(req);
    if (!m) return void res.status(503).json({ error: 'no_marketplaces' });
    const { url } = (req.body ?? {}) as { url?: unknown };
    if (typeof url !== 'string') return void res.status(400).json({ error: 'url is required' });
    try { res.status(201).json(await m.add(url.trim())); } catch (e) { installError(res, e); }
  });
  router.delete('/plugins/marketplaces/:slug', ownerOnlyStrict, (req, res) => {
    const m = marketsOf(req);
    if (!m) return void res.status(503).json({ error: 'no_marketplaces' });
    try { m.remove(req.params.slug); res.status(204).end(); } catch (e) { installError(res, e); }
  });
  router.post('/plugins/marketplaces/:slug/pull', ownerOnlyStrict, async (req, res) => {
    const m = marketsOf(req);
    if (!m) return void res.status(503).json({ error: 'no_marketplaces' });
    try { res.json(await m.pull(req.params.slug)); } catch (e) { installError(res, e); }
  });
  router.post('/plugins/marketplaces/:slug/trusted', ownerOnlyStrict, (req, res) => {
    const m = marketsOf(req);
    if (!m) return void res.status(503).json({ error: 'no_marketplaces' });
    try { res.json(m.setTrusted(req.params.slug, (req.body as { on?: unknown })?.on === true)); } catch (e) { installError(res, e); }
  });
  // The catalog, with what is installed beside each plugin.
  router.get('/plugins/catalog', ownerOnlyStrict, async (req, res) => {
    const m = marketsOf(req);
    if (!m) return void res.status(503).json({ error: 'no_marketplaces' });
    const skillRows = skillsOf(req)?.list() ?? [];
    const urlOf = (slug: string) => m.get(slug)?.url ?? null;
    // "Installed" names the copy that came from THIS marketplace; the same id from another one is not it.
    const entries = (await m.catalog()).map((e) => {
      const rec = e.kind === 'plugin' ? plugins.get(e.id)?.install ?? null : skillRows.find((s) => s.id === e.id)?.install ?? null;
      const installed = rec && rec.marketplace === urlOf(e.marketplace) ? rec : null;
      return { ...e, folder: undefined, ...(installed ? { installed: { version: installed.version } } : {}) };
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ entries });
  });
  router.get('/plugins/updates', ownerOnlyStrict, async (req, res) => {
    const i = installerOf(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ updates: i ? await i.updates() : [] });
  });
  router.post('/plugins/updates/check', ownerOnlyStrict, async (req, res) => {
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    try { res.json(await i.checkNow()); } catch (e) { installError(res, e); }
  });
  router.post('/plugins/install', ownerOnlyStrict, async (req, res) => {
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    const { marketplace, id, version } = (req.body ?? {}) as { marketplace?: unknown; id?: unknown; version?: unknown };
    if (typeof marketplace !== 'string' || typeof id !== 'string') return void res.status(400).json({ error: 'marketplace and id are required' });
    try { res.status(201).json(await i.install(marketplace, id, typeof version === 'string' ? version : undefined)); } catch (e) { installError(res, e); }
  });
  router.get('/plugins/:id/versions', ownerOnlyStrict, async (req, res) => {
    const m = marketsOf(req);
    const row = plugins.get(req.params.id);
    if (!row) return void res.status(404).json({ error: 'unknown plugin' });
    const market = row.install ? m?.list().find((x) => x.url === row.install!.marketplace) : null;
    res.json({ versions: market && m ? await m.versions(market.slug, req.params.id) : [] });
  });
  router.post('/plugins/:id/update', ownerOnlyStrict, async (req, res) => {
    if (!known(req, res)) return;
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    try { res.json(await i.update(req.params.id)); } catch (e) { installError(res, e); }
  });
  router.post('/plugins/:id/rollback', ownerOnlyStrict, async (req, res) => {
    if (!known(req, res)) return;
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    try { res.json(await i.rollback(req.params.id)); } catch (e) { installError(res, e); }
  });
  router.post('/plugins/:id/pin', ownerOnlyStrict, (req, res) => {
    if (!known(req, res)) return;
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    const v = (req.body as { version?: unknown })?.version;
    i.pin(req.params.id, typeof v === 'string' && v ? v : null);
    res.json(plugins.get(req.params.id));
  });
  router.post('/plugins/:id/auto-update', ownerOnlyStrict, (req, res) => {
    if (!known(req, res)) return;
    const i = installerOf(req);
    if (!i) return void res.status(503).json({ error: 'no_installer' });
    i.setAutoUpdate(req.params.id, (req.body as { on?: unknown })?.on === true);
    res.json(plugins.get(req.params.id));
  });

  // ── skills (spec section 8): the list is readable by every key; the rest is the owner's ──
  const skillError = (res: import('express').Response, e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(/unknown skill|unknown marketplace|not in the marketplace/.test(msg) ? 404 : /already installed/.test(msg) ? 409 : 400).json({ error: msg });
  };
  router.get('/skills', keyRoute({ thread: projectListRule, roleRun: projectListRule, plugin: needs('read:projects') }), (req, res) => {
    let principal: ReturnType<typeof principalOf> | null = null;
    try { principal = principalOf(req); } catch { principal = null; }
    res.setHeader('Cache-Control', 'no-store');
    if (principal?.kind === 'thread') {
      // A thread sees the skills its own project gets (what is in its prompt), and no paths or marketplace URLs.
      const own = scopeOf(req).caller(principal.terminalId)?.sessionId;
      const rows = (skillsOf(req)?.list(own) ?? []).filter((s) => s.enabled && s.enabledHere !== false && !s.error);
      return void res.json({ skills: rows.map((s) => ({ id: s.id, name: s.name, version: s.version, description: s.description, harnesses: s.harnesses, enabled: true, enabledHere: true, text: s.text.length > 400 ? `${s.text.slice(0, 400)}…` : s.text })) });
    }
    const project = typeof req.query.project === 'string' ? req.query.project : undefined;
    // The text stays short in the list; the owner's page shows it on demand.
    res.json({ skills: (skillsOf(req)?.list(project) ?? []).map((s) => ({ ...s, text: s.text.length > 400 ? `${s.text.slice(0, 400)}…` : s.text })) });
  });
  router.post('/skills/install', ownerOnlyStrict, async (req, res) => {
    const sv = skillsOf(req);
    if (!sv) return void res.status(503).json({ error: 'no_skills' });
    const { marketplace, id } = (req.body ?? {}) as { marketplace?: unknown; id?: unknown };
    if (typeof marketplace !== 'string' || typeof id !== 'string') return void res.status(400).json({ error: 'marketplace and id are required' });
    try { res.status(201).json(await sv.install(marketplace, id)); } catch (e) { skillError(res, e); }
  });
  // A new skill from a draft (coach spec section 4.8): the owner's one click on Create.
  router.post('/skills', ownerOnlyStrict, (req, res) => {
    const sv = skillsOf(req);
    if (!sv) return void res.status(503).json({ error: 'no_skills' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.id !== 'string' || typeof b.name !== 'string' || typeof b.body !== 'string') return void res.status(400).json({ error: 'id, name and body are required' });
    try {
      const skill = sv.create({ id: b.id, name: b.name, description: typeof b.description === 'string' ? b.description : '', body: b.body, ...(b.projects !== undefined ? { projects: b.projects as string[] } : {}) });
      res.status(201).json({ skill });
    } catch (e) { skillError(res, e); }
  });
  router.delete('/skills/:id', ownerOnlyStrict, (req, res) => {
    const sv = skillsOf(req);
    if (!sv) return void res.status(503).json({ error: 'no_skills' });
    try { sv.remove(req.params.id); res.status(204).end(); } catch (e) { skillError(res, e); }
  });
  for (const [action, on] of [['enable', true], ['disable', false]] as const) {
    router.post(`/skills/:id/${action}`, ownerOnlyStrict, (req, res) => {
      const sv = skillsOf(req);
      if (!sv) return void res.status(503).json({ error: 'no_skills' });
      if (!sv.list().some((s) => s.id === req.params.id)) return void res.status(404).json({ error: 'unknown skill' });
      const project = (req.body as { project?: unknown })?.project;
      sv.setEnabled(req.params.id, on, typeof project === 'string' && project ? project : undefined);
      res.json(sv.list(typeof project === 'string' ? project : undefined).find((s) => s.id === req.params.id));
    });
  }

  // ── the worker (spec section 4): logs, restart, and the socket proxy ──────────────────────
  const workersOf = (req: Request): PluginWorkers | null => (req.app.locals.pluginWorkers as PluginWorkers | undefined) ?? null;

  router.get('/plugins/:id/logs', (req, res) => {
    if (!known(req, res)) return;
    const lines = Math.max(1, Math.min(2000, Number(req.query.lines) || 200));
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain').send(workersOf(req)?.logTail(req.params.id, lines) ?? '');
  });

  // Before the proxy's catch-all: the owner's Restart is the daemon's, not the worker's.
  router.post('/plugins/:id/worker/restart', ownerOnlyStrict, (req, res) => {
    if (!known(req, res)) return;
    const w = workersOf(req);
    if (!w) return void res.status(503).json({ error: 'no_supervisor' });
    w.restart(req.params.id);
    res.json(w.stats(req.params.id) ?? { state: 'stopped' });
  });

  // The proxy: the caller's principal in headers, never its credential; the worker answers as itself.
  const workerRule = keyRoute({ plugin: ownPluginRule, thread: grantRule(plugins, 'call-worker'), roleRun: grantRule(plugins, 'call-worker') });
  router.all(['/plugins/:id/worker', '/plugins/:id/worker/*'], workerRule, (req, res) => {
    if (!known(req, res)) return;
    const stats = workersOf(req)?.stats(req.params.id);
    if (!stats?.socket) return void res.status(502).json({ error: 'no_worker', message: 'The plugin has no worker listening.' });
    // The path as the caller encoded it (Express decodes params): sliced from the raw URL after /worker.
    const marker = `/plugins/${req.params.id}/worker`;
    const at = req.originalUrl.indexOf(marker);
    const tail = at >= 0 ? req.originalUrl.slice(at + marker.length) : '';
    const upstreamPath = tail === '' ? '/' : tail.startsWith('/') ? tail : `/${tail}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROPPED_HEADERS.has(k.toLowerCase()) && typeof v === 'string') headers[k] = v;
    Object.assign(headers, principalHeaders(req));
    const hasJson = req.is('application/json') && req.body !== undefined && typeof req.body === 'object';
    const body = hasJson ? Buffer.from(JSON.stringify(req.body)) : null;
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length); }
    const up = http.request({ socketPath: stats.socket, path: upstreamPath, method: req.method, headers }, (r) => {
      res.status(r.statusCode ?? 502);
      for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !['connection', 'keep-alive', 'transfer-encoding'].includes(k)) res.setHeader(k, v as string | string[]);
      r.pipe(res);
      r.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'no_worker' }); else res.end(); });
    });
    up.setTimeout(60_000, () => up.destroy(new Error('timeout')));
    up.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'no_worker', message: 'The worker did not answer.' }); else res.end(); });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    if (body) up.end(body);
    else if (req.method === 'GET' || req.method === 'HEAD') up.end();
    else req.pipe(up);
  });

  // ── plugin push (coach spec section 9a.5): its own key with notify:push, at most one an hour ──
  // There are no daemon-wide quiet hours today; a plugin keeps its own (the Coach's do).
  const lastPush = new Map<string, number>();
  const notifyRule: Rule = (req, ctx) => { const own = ownPluginRule(req, ctx); return own.ok ? needs('notify:push')(req, ctx) : own; };
  router.post('/plugins/:id/notify', keyRoute({ plugin: notifyRule }), async (req, res) => {
    let kind: string;
    try { kind = principalOf(req).kind; } catch { kind = 'owner'; }
    if (kind !== 'plugin') return void res.status(403).json({ error: 'out_of_scope', message: "A plugin's push comes from its own key." });
    if (!known(req, res)) return;
    const body = (req.body ?? {}) as { title?: unknown; body?: unknown; url?: unknown };
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!title || title.length > 120 || !text || text.length > 500) return void res.status(400).json({ error: 'bad_body', message: 'Send { title (1-120 characters), body (1-500), url? }.' });
    // An app path only: never another origin.
    if (body.url !== undefined && !(typeof body.url === 'string' && /^\/(?![/\\])[^\s]{0,500}$/.test(body.url))) {
      return void res.status(400).json({ error: 'bad_url', message: 'url is an app path that starts with one /.' });
    }
    if (!limits.push) return void res.status(503).json({ error: 'no_push', message: 'Push is not available on this daemon.' });
    const now = Date.now();
    const last = lastPush.get(req.params.id);
    if (last !== undefined && now - last < PUSH_GAP_MS) {
      return void res.status(429).json({ error: 'rate_limited', message: 'A plugin sends at most one push an hour.', retryAfterSeconds: Math.ceil((PUSH_GAP_MS - (now - last)) / 1000) });
    }
    lastPush.set(req.params.id, now);
    try { await limits.push.notifyPlugin({ pluginId: req.params.id, title, body: text, ...(typeof body.url === 'string' ? { url: body.url } : {}) }); }
    catch { return void res.status(502).json({ error: 'push_failed', message: 'The push could not be sent.' }); }
    res.json({ ok: true });
  });

  // ── the model budget (coach spec sections 4.5, 7.4): owner-only, enforced before each assist call ──
  // The owner's budget, else the plugin's manifest default (set by the plugin, so it holds from the
  // first call, before any web part loads), else no cap.
  const budgetOf = (id: string): pluginData.PluginBudget => pluginData.getBudgetRow(db, id) ?? (plugins.get(id)?.budget ? { ...plugins.get(id)!.budget! } : { percentWeekly: null, usdWeekly: null });
  const budgets = createBudgetGuard(db, limits, budgetOf);
  // The owner, or the plugin's own key: its worker reads the cap it plans by (never writes it).
  router.get('/plugins/:id/budget', keyRoute({ plugin: ownPluginRule }), (req, res) => {
    if (!known(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(budgetOf(req.params.id));
  });
  router.put('/plugins/:id/budget', ownerOnlyStrict, (req, res) => {
    if (!known(req, res)) return;
    const body = (req.body ?? {}) as { percentWeekly?: unknown; usdWeekly?: unknown };
    const next = budgetOf(req.params.id);
    if (body.percentWeekly !== undefined) {
      if (body.percentWeekly !== null && !(typeof body.percentWeekly === 'number' && body.percentWeekly >= 0.1 && body.percentWeekly <= 100)) {
        return void res.status(400).json({ error: 'bad_budget', message: 'percentWeekly is 0.1 to 100, or null for no cap.' });
      }
      next.percentWeekly = body.percentWeekly as number | null;
    }
    if (body.usdWeekly !== undefined) {
      if (body.usdWeekly !== null && !(typeof body.usdWeekly === 'number' && Number.isFinite(body.usdWeekly) && body.usdWeekly >= 0 && body.usdWeekly <= 10_000)) {
        return void res.status(400).json({ error: 'bad_budget', message: 'usdWeekly is 0 to 10000 dollars, or null for no cap.' });
      }
      next.usdWeekly = body.usdWeekly as number | null;
    }
    res.json(pluginData.setBudget(db, req.params.id, next));
  });

  // ── model assist (spec section 3.4): the plugin's own key with model:assist, or the owner ──
  const assistRule: Rule = (req, ctx) => { const own = ownPluginRule(req, ctx); return own.ok ? needs('model:assist')(req, ctx) : own; };
  // A bound per plugin: each call is a model process on the owner's account.
  const inflight = new Map<string, number>();
  router.post('/plugins/:id/assist', keyRoute({ plugin: assistRule }), async (req, res) => {
    if (!known(req, res)) return;
    const body = (req.body ?? {}) as { system?: unknown; messages?: unknown; maxTokens?: unknown; harness?: unknown; model?: unknown; accountId?: unknown };
    const messages = Array.isArray(body.messages) ? body.messages.filter((m): m is { role: 'user' | 'assistant'; content: string } => !!m && typeof m === 'object' && ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant') && typeof (m as { content?: unknown }).content === 'string') : [];
    if (messages.length === 0) return void res.status(400).json({ error: 'bad_body', message: 'Send { messages: [{ role: "user", content: "..." }], system?, maxTokens?, harness?, model? }.' });
    const maxTokens = Math.max(1, Math.min(2000, typeof body.maxTokens === 'number' ? Math.floor(body.maxTokens) : 800));
    // The harness and model the caller chose (coach spec section 7.1): a known harness, a model id with no spaces.
    if (body.harness !== undefined && !(typeof body.harness === 'string' && (body.harness === 'auto' || (ASSIST_HARNESSES as readonly string[]).includes(body.harness)))) {
      return void res.status(400).json({ error: 'bad_harness', message: `harness is one of ${[...ASSIST_HARNESSES, 'auto'].join(', ')}.` });
    }
    if (body.model !== undefined && !(typeof body.model === 'string' && ASSIST_ID_RE.test(body.model))) {
      return void res.status(400).json({ error: 'bad_model', message: 'model is a model id: 1 to 120 characters, no spaces.' });
    }
    if (body.accountId !== undefined && !(typeof body.accountId === 'string' && ASSIST_ID_RE.test(body.accountId))) {
      return void res.status(400).json({ error: 'bad_account', message: 'accountId is an account id: 1 to 120 characters, no spaces.' });
    }
    let harness = body.harness as AssistHarness | 'auto' | undefined;
    const model = body.model as string | undefined;
    let accountId = body.accountId as string | undefined;
    // An account the daemon does not know is refused: the runner would fall back to the default
    // account while the budget guard checked the unknown one (no figures = no cap).
    if (accountId !== undefined && harness !== 'openrouter' && harness !== 'auto' && !knownAccount(harness === 'codex' ? 'codex' : 'claude', accountId)) {
      return void res.status(400).json({ error: 'unknown_account', message: `No ${harness === 'codex' ? 'Codex' : 'Claude'} account has the id "${accountId}".` });
    }
    if (!assist || !(await assist.available(harness).catch(() => false))) {
      return void res.status(503).json({ error: 'no_model', message: 'No model is signed in for assist. Sign in to Claude Code or set an OpenRouter key.' });
    }
    // `auto` is resolved here when the runner can say what it would pick, so that account's budget is the one checked.
    if (harness === 'auto' && assist.pick) {
      const pick = await assist.pick();
      if (!pick) return void res.status(503).json({ error: 'no_model', message: 'No signed-in account has room for assist right now.' });
      harness = pick.harness;
      accountId = pick.harness === 'openrouter' ? undefined : pick.accountId;
    }
    // The effective account, resolved once: the budget guard checks it, the runner runs on it, the meter names it.
    if (harness === 'openrouter') accountId = undefined;
    else accountId = accountId ?? limits.defaultAccount?.(harness === 'codex' ? 'codex' : 'claude') ?? 'cli';
    // From here to the reservation nothing awaits: the check and the reservation are one step, so
    // concurrent calls each see the ones before them (coach plan, Review Focus 1).
    const busy = inflight.get(req.params.id) ?? 0;
    if (busy >= ASSIST_INFLIGHT_MAX) return void res.status(429).json({ error: 'busy', message: `At most ${ASSIST_INFLIGHT_MAX} assist calls run at once for a plugin.` });
    const promptChars = (typeof body.system === 'string' ? body.system.length : 0) + messages.reduce((n, m) => n + m.content.length, 0);
    const check = budgets.check(req.params.id, { harness, accountId, model, maxTokens, promptChars });
    for (const [k, v] of Object.entries(check.headers)) res.setHeader(k, v);
    if (check.refuse) return void res.status(429).json(check.refuse);
    inflight.set(req.params.id, busy + 1);
    let result;
    const started = Date.now();
    try { result = await assist.run({ system: typeof body.system === 'string' ? body.system : undefined, messages, maxTokens, ...(harness ? { harness } : {}), ...(model ? { model } : {}), ...(accountId ? { accountId } : {}) }).catch(() => null); }
    finally {
      inflight.set(req.params.id, (inflight.get(req.params.id) ?? 1) - 1);
      check.release();
    }
    const asked = harness && harness !== 'auto' ? harness : '';
    if (!result) {
      // A failed call is metered too (ok = 0), so the Plugins page and a budget see it.
      pluginData.recordAssist(db, req.params.id, { model: model ?? '', harness: asked, accountId: accountId ?? null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: null, ms: Date.now() - started, ok: false });
      return void res.status(502).json({ error: 'no_answer', message: 'The model gave no answer.' });
    }
    pluginData.recordAssist(db, req.params.id, meterOf(result, asked, started, accountId));
    res.json(result);
  });

  // A plugin's estimated share of an account's 5-hour and weekly windows (coach spec section 7.3).
  // Usage figures: a plugin key needs read:usage (the owner may always read them).
  const shareRule: Rule = (req, ctx) => { const own = ownPluginRule(req, ctx); return own.ok ? needs('read:usage')(req, ctx) : own; };
  router.get('/plugins/:id/assist/share', keyRoute({ plugin: shareRule }), (req, res) => {
    if (!known(req, res)) return;
    const h = req.query.harness ?? 'claude';
    if (h !== 'claude' && h !== 'codex') return void res.status(400).json({ error: 'bad_harness', message: 'harness is claude or codex (OpenRouter has no limit windows).' });
    const accountId = typeof req.query.accountId === 'string' && ASSIST_ID_RE.test(req.query.accountId) ? req.query.accountId : (limits.defaultAccount?.(h) ?? 'cli');
    const summary = (() => { try { return limits.summary?.() ?? null; } catch { return null; } })();
    const opts = { pluginId: req.params.id, accountId, harness: h as AssistHarness, defaultAccountId: limits.defaultAccount?.(h) ?? 'cli' };
    res.setHeader('Cache-Control', 'no-store');
    const sevenDay = estimateShare(db, summary, { ...opts, window: 'seven_day' });
    // With no weekly figure and a percent budget, the guard holds the plugin to a token cap: say so.
    const budget = budgetOf(req.params.id);
    const fallback = !sevenDay && budget.percentWeekly !== null ? budgets.tokenFallback(req.params.id, budget.percentWeekly) : null;
    res.json({ fiveHour: estimateShare(db, summary, { ...opts, window: 'five_hour' }), sevenDay, ...(fallback ? { fallback } : {}) });
  });

  // The meter by time (coach spec section 7.2): the owner, or the plugin's own key. No `from` = 7 days ago.
  router.get('/plugins/:id/assist/usage', keyRoute({ plugin: ownPluginRule }), (req, res) => {
    if (!known(req, res)) return;
    const range = rangeOf(req.query.from, req.query.to);
    if (!range) return void res.status(400).json({ error: 'bad_range', message: 'from and to are ISO times.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(pluginData.assistUsage(db, req.params.id, range.from, range.to));
  });

  return router;
}

/** Plugin files that compress well; anything else (an image, a font) is sent as it is. */
const PLUGIN_TEXT = new Set(['.js', '.mjs', '.css', '.json', '.map', '.html', '.htm', '.svg', '.txt', '.md']);
/** Compressed plugin files, by encoding, path and stamp. A new stamp is a new key; the oldest key goes first. */
const pluginBodies = new Map<string, Promise<Buffer>>();
const PLUGIN_BODIES_MAX = 64;

function compressedPluginFile(abs: string, stamp: number, enc: 'br' | 'gzip'): Promise<Buffer> {
  const key = `${enc}:${stamp}:${abs}`;
  let body = pluginBodies.get(key);
  if (!body) {
    body = fs.promises.readFile(abs).then((raw) => new Promise<Buffer>((resolve, reject) => {
      const done = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out));
      if (enc === 'br') zlib.brotliCompress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }, done);
      else zlib.gzip(raw, { level: 9 }, done);
    }));
    pluginBodies.set(key, body);
    body.catch(() => pluginBodies.delete(key));
    if (pluginBodies.size > PLUGIN_BODIES_MAX) pluginBodies.delete(pluginBodies.keys().next().value as string);
  }
  return body;
}

/**
 * `GET /plugins/<id>/<path>`: a file of an enabled plugin, same-origin so the app's CSP lets the
 * client import it. HTML gets the previews' sandbox: a plugin page in a frame runs with no cookie
 * and no app origin.
 *
 * Cache (W2-H): the app loads a bundle as `<path>?v=<stamp>`, and the stamp changes when any file of
 * the plugin changes. A request whose `v` IS the plugin's current stamp names bytes that never change
 * under that address, so it is kept for good and sent compressed; before, each launch asked for every
 * bundle again, uncompressed. Any other request (no `v`, an old or a wrong `v`) is `no-cache` and
 * as-is, as before: the author is editing the file.
 */
export function pluginAssetHandler(plugins: PluginRegistry): RequestHandler[] {
  return [publicRoute, (req, res) => {
    const id = String(req.params.id ?? '');
    let rest: string;
    try { rest = decodeURIComponent(String(req.params[0] ?? '')); } catch { return void res.status(404).json({ error: 'plugin file not found' }); }
    const abs = plugins.resolveFile(id, rest);
    if (!abs) return void res.status(404).json({ error: 'plugin file not found' });
    const v = req.query.v;
    const stamp = plugins.get(id)?.stamp;
    const current = typeof v === 'string' && typeof stamp === 'number' && v === String(stamp);
    res.setHeader('Cache-Control', current ? IMMUTABLE : 'no-cache');
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.html' || ext === '.htm') setFileHeaders(res, 'text/html', HTML_SANDBOX_CSP);
    else if (ext === '.svg') setFileHeaders(res, 'image/svg+xml', 'sandbox');
    const enc = current && PLUGIN_TEXT.has(ext) ? pickEncoding(req.headers['accept-encoding'] as string | undefined) : null;
    if (!enc) return void res.sendFile(abs);
    compressedPluginFile(abs, stamp as number, enc).then((buf) => {
      if (!res.getHeader('Content-Type')) res.type(ext);
      res.setHeader('Content-Encoding', enc);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', String(buf.length));
      res.end(buf);
    }, () => { res.sendFile(abs); });
  }];
}
