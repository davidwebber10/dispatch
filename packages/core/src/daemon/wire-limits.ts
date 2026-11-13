import path from 'path';
import type { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import * as terminalsDb from '../db/terminals.js';
import type { SessionService } from '../sessions/service.js';
import type { StatusService } from '../status/service.js';
import type { EndlessService } from '../endless/service.js';
import type { PushService } from '../push/service.js';
import type { ClaudeLoginService } from '../auth/claude-login.js';
import type { AccountsStore } from '../auth/accounts.js';
import type { IStructuredManager } from '../structured/manager.js';
import type { EventBroadcaster } from '../ws/events.js';
import type { ApiRouteDeps } from '../server-routes.js';
import type { UsageLimit } from '../limits/detect.js';
import { UsageLimitService, CHAT_ID, isChatTurnId } from '../limits/service.js';
import { LimitSnapshots, parseClaudeRateLimit } from '../limits/snapshot.js';
import { accountIdFor, tokenAccountId, codexAccountId, codexLoginChangedAt } from '../limits/account.js';
import { UsageGauge } from '../limits/gauge.js';
import { createCodexRefresh, type CodexRefresh } from '../limits/codex-refresh.js';
import { createCodexPoll, type CodexPoll } from '../limits/codex-poll.js';
import { createClaudeProbe } from '../limits/claude-probe.js';
import { createClaudeUsageReader, readClaudeToken } from '../limits/claude-usage.js';
import { childEnv } from '../platform/inherited-env.js';
import { createClaudeGetUsageProbe } from '../limits/claude-get-usage.js';
import { usageWithoutToken } from '../os/hosted-mode.js';

/** The account a thread is pinned to (multi-account), read from its stored config. Null: the default. */
function threadAccountId(config: string | null | undefined): string | null {
  try { const id = (JSON.parse(config || '{}') as { accountId?: unknown }).accountId; return typeof id === 'string' && id ? id : null; } catch { return null; }
}

export interface LimitInputs {
  db: Database.Database;
  env: NodeJS.ProcessEnv;
  sessionService: SessionService;
  statusService: StatusService;
  endless: EndlessService;
  /** Chat's own Claude manager. */
  endlessManager: IStructuredManager;
  /** The Claude manager of the threads. */
  claudeManager: IStructuredManager;
  accounts: AccountsStore;
  claudeLogin: ClaudeLoginService;
  pushService: PushService;
  broadcaster: EventBroadcaster;
  /** The spawn env of a thread, as the last refresh left it (daemon/wire-pty.ts). */
  spawnEnv: () => Record<string, string>;
  /** False: no account is read from Anthropic or from the Codex CLI. The figures of the threads still arrive. */
  network: boolean;
  clock?: () => number;
}

export interface LimitServices {
  usageLimits: UsageLimitService;
  limitSnapshots: LimitSnapshots;
  usageGauge: UsageGauge;
  /** Which login an account is on. */
  limitAccount: (provider: string, accountId?: string) => string;
  refreshCodex: CodexRefresh;
  pollCodex: CodexPoll;
  /** What `/api/usage-limits` needs. */
  routeDeps: NonNullable<ApiRouteDeps['usageLimits']>;
}

/**
 * Usage-limit auto-resume and the usage gauge.
 *
 * A thread an agent CLI stopped for its quota is parked in the db and woken after the reset
 * (limits/service.ts). The managers emit 'usage-limit'; SessionService routes it here. Chat's own
 * turn parks under CHAT_ID and wakes through Chat's retry.
 */
export function wireLimits(i: LimitInputs): LimitServices {
  const { db, sessionService, statusService, endless, endlessManager, accounts, claudeLogin, broadcaster } = i;
  const now = i.clock ?? Date.now;
  const usageLimits = new UsageLimitService({
    db,
    markPaused: (id, label) => { if (id !== CHAT_ID) statusService.markScheduled(id, label); },
    wake: (id, text) => sessionService.resumeAfterUsageLimit(id, text),
    note: (id, text, o) => endless.noteLimit(id === CHAT_ID ? null : id, text, o.deliver),
    chat: { isBusy: () => endless.turns.status !== 'idle', wake: () => endless.wakeAfterLimit() },
    ...(i.clock ? { now: i.clock } : {}),
  });
  // The account's limit figures for the Details panel: Claude from its stream, Codex from its session file (routes/usage-limits.ts).
  const limitSnapshots = new LimitSnapshots(db);
  // A headless box signs in with an injected token (the CLI's own file does not change), so that token is the account.
  // Which login an account is on, so a figure from one login is never shown as current after a switch
  // (limits/account.ts). `cli`: the CLI's own file or keychain; an added Claude account: its token;
  // an added Codex account: the auth.json in its own folder.
  const limitAccount = (provider: string, accountId = 'cli'): string => {
    if (accountId !== 'cli') {
      if (provider === 'claude-code') return tokenAccountId(accounts.claudeToken(accountId)) || `acct:${accountId}`;
      const dir = accounts.codexHome(accountId);
      return (dir && codexAccountId({ ...i.env, CODEX_HOME: dir })) || `acct:${accountId}`;
    }
    return (provider === 'claude-code' && tokenAccountId(claudeLogin.getToken())) || accountIdFor(provider);
  };
  for (const m of [i.claudeManager, endlessManager] as EventEmitter[]) {
    m.on('rate-limit', (id: string, info: unknown) => {
      // A thread with no account of its own runs on the daemon's default env, so its figures belong to the Claude default account.
      const acc = threadAccountId(terminalsDb.getById(db, id)?.config) ?? accounts.defaultId('claude');
      limitSnapshots.record('claude-code', limitAccount('claude-code', acc), parseClaudeRateLimit(info), now(), undefined, false, undefined, acc);
    });
  }
  // The usage gauge (#127): the header chip, the paused banner and the one-push-per-window warning.
  // It hears every recorded snapshot and every pause change, and refreshes Codex on its own tick.
  // Per account (multi-account spec 2026-11-06): the CLI login reads as before; an added Claude
  // account reads with its own token; an added Codex account reads under its own CODEX_HOME.
  const codexEnvFor = (accountId: string): Record<string, string> => {
    const dir = accountId === 'cli' ? null : accounts.codexHome(accountId);
    return childEnv(i.spawnEnv(), dir ? { CODEX_HOME: dir } : {});
  };
  const codexRootsFor = (accountId: string) => {
    const dir = accountId === 'cli' ? null : accounts.codexHome(accountId);
    return dir ? { sessions: path.join(dir, 'sessions'), archived: path.join(dir, 'archived_sessions') } : null;
  };
  const refreshCodex = createCodexRefresh(limitSnapshots, {
    accountFor: limitAccount, rootsFor: codexRootsFor,
    codexLoginChangedAt: (accountId) => { const dir = accountId === 'cli' ? null : accounts.codexHome(accountId); return codexLoginChangedAt(dir ? { ...i.env, CODEX_HOME: dir } : i.env); },
  });
  // With no Codex thread of an account active lately, ask Codex itself (codex-poll.ts), signed in as a thread is.
  const pollCodex = createCodexPoll({ snapshots: limitSnapshots, accountFor: limitAccount, env: codexEnvFor });
  // Claude's figures for CLI-only use: a tiny background turn when they go stale (claude-probe.ts).
  // An added account runs it with its own token: its `setup-token` token cannot read the usage endpoint (2026-11-07).
  const probeClaude = createClaudeProbe({
    snapshots: limitSnapshots, accountFor: limitAccount,
    env: (accountId = 'cli') => childEnv(i.spawnEnv(), accountId === 'cli' ? {} : accounts.spawnEnv('claude-code', { accountId })),
  });
  // Claude's usage as claude.ai shows it (claude-usage.ts): every window, Fable included, and the extra-usage
  // spend. `cli` reads with the CLI's own login (file or keychain); an added account with its saved token.
  // The tiny turn above is the fallback when an account's read fails.
  const readClaudeUsage = createClaudeUsageReader({
    snapshots: limitSnapshots, accountFor: limitAccount,
    token: async (accountId) => (accountId === 'cli' ? readClaudeToken({}) : accounts.claudeToken(accountId)),
  });
  const accountRefs = () => [
    ...accounts.list('claude').map((a) => ({ provider: 'claude-code', accountId: a.id, label: a.label })),
    ...accounts.list('codex').map((a) => ({ provider: 'codex', accountId: a.id, label: a.label })),
  ];
  // The readers that leave the process (Anthropic, the Codex CLI, a Claude turn) exist only with the network.
  // A hosted box (the clean login) reads no Claude credential: no token reader, no credits read, and the
  // probe is Claude Code's own get_usage control request (no model turn). With no figures the rings hide.
  const tokenless = usageWithoutToken(i.env);
  const getUsage = createClaudeGetUsageProbe({
    snapshots: limitSnapshots, accountFor: limitAccount,
    env: (accountId = 'cli') => childEnv(i.spawnEnv(), accountId === 'cli' ? {} : accounts.spawnEnv('claude-code', { accountId })),
  });
  const remote = !i.network ? {}
    : tokenless
      ? { pollCodex, codexCredits: (accountId?: string) => pollCodex.credits(accountId), probeClaude: getUsage }
      : { pollCodex, codexCredits: (accountId?: string) => pollCodex.credits(accountId), claudeCredits: (accountId?: string) => readClaudeUsage.credits(accountId), probeClaude, readClaudeUsage };
  const usageGauge = new UsageGauge({
    db, snapshots: limitSnapshots, broadcast: (e) => broadcaster.broadcast(e as { type: string }), push: i.pushService, accountFor: limitAccount, accounts: accountRefs,
    refreshCodex, ...remote, claudeTokenStamp: (accountId) => accounts.claudeTokenStamp(accountId), ...(i.clock ? { now: i.clock } : {}),
  });
  accounts.onChange(() => usageGauge.accountsChanged());
  // W1-H: what each Claude sign-in can do for the usage figures rides on the accounts view; "Check again" reads now.
  accounts.setUsageAccessSource((accountId) => usageGauge.claudeUsageAccess(accountId));
  accounts.onCheckUsage((accountId) => usageGauge.checkClaudeNow(accountId));
  limitSnapshots.addRecordListener((provider, accountId) => usageGauge.onRecord(provider, accountId));
  usageLimits.addChangeListener(() => usageGauge.pausesChanged());
  // A finished turn ends a resumed thread's retry chain: CLI threads through the status settle,
  // Chat through its own manager. An owner action on Chat ends its pause.
  statusService.addThreadSettledListener(({ terminalId }) => usageLimits.onTurnSettled(terminalId));
  endlessManager.on('idle', (id: string) => { if (isChatTurnId(id)) usageLimits.onTurnSettled(CHAT_ID); });
  endlessManager.on('failed', (id: string) => { if (isChatTurnId(id)) usageLimits.onTurnEnded(CHAT_ID); });
  endlessManager.on('needs-help', (id: string) => { if (isChatTurnId(id)) usageLimits.onTurnSettled(CHAT_ID); });
  endless.onOwnerAction = () => usageLimits.onUserMessage(CHAT_ID);
  endlessManager.on('usage-limit', (id: string, limit: UsageLimit) => {
    if (isChatTurnId(id) && endless.turns.status !== 'idle') usageLimits.park(CHAT_ID, 'claude-code', limit);
  });
  return {
    usageLimits, limitSnapshots, usageGauge, limitAccount, refreshCodex, pollCodex,
    routeDeps: {
      snapshots: limitSnapshots, accountFor: limitAccount, refreshCodex,
      summary: () => usageGauge.summary(), refresh: () => usageGauge.refreshNow(), onSettingsChange: () => usageGauge.settingsChanged(),
      useResetCredit: (p: string, creditId?: string, accountId?: string) => (p === 'codex' && i.network ? pollCodex.useCredit(creditId, accountId) : Promise.resolve(null)),
    },
  };
}
