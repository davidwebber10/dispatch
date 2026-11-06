import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import type { ClaudeLoginService } from '../auth/claude-login.js';
import { ACCOUNT_PROVIDERS, type AccountProvider, type AccountsStore } from '../auth/accounts.js';
import { clientMessage } from '../http/client-message.js';

/** A thread pinned to an account, as the delete notice lists it. */
export interface PinnedThread { id: string; label: string; sessionId: string }
export interface AccountsRouteExtras {
  /** The Claude profile (email, plan) behind an account's token; null when it cannot be read. */
  claudeProfile?: (accountId: string) => Promise<{ email?: string; plan?: string } | null>;
  threads?: {
    pinnedTo: (provider: AccountProvider, accountId: string) => PinnedThread[];
    /** Drop the pin from every thread of the account; returns how many. They use the default next start. */
    unpin: (provider: AccountProvider, accountId: string) => number;
  };
}
const PROFILE_TTL_MS = 10 * 60_000;
const PROFILE_RETRY_MS = 2 * 60_000;
const PROFILE_WAIT_MS = 3_000;

const isProvider = (v: unknown): v is AccountProvider => typeof v === 'string' && (ACCOUNT_PROVIDERS as readonly string[]).includes(v);

/**
 * Accounts per harness (docs/superpowers/specs/2026-11-06-multi-account-design.md). Owner only
 * (policyRouter's default): a thread key may not list or change logins.
 *
 *   GET    /api/accounts                      every account, no tokens
 *   POST   /api/accounts/claude/login { label } start the headless login for a NEW Claude account
 *                                             (finish with POST /api/claude-auth/login/code)
 *   POST   /api/accounts/codex { label }      a new Codex account folder; sign it in with a
 *                                             "Sign in — Codex" thread that carries its id
 *   PUT    /api/accounts/:provider/default { id }
 *   DELETE /api/accounts/:provider/:id
 */
export function createAccountsRouter(accounts: AccountsStore, claudeLogin: ClaudeLoginService, extras: AccountsRouteExtras = {}): Router {
  const router = policyRouter();
  // Claude profiles (email, plan) learned for the list, by account id: the CLI login's is never
  // stored, an added account's is written back. A miss is retried after a short while.
  const profiles = new Map<string, { at: number; p: { email?: string; plan?: string } | null }>();
  const claudeProfileOf = async (id: string) => {
    const hit = profiles.get(id);
    if (hit && Date.now() - hit.at < (hit.p ? PROFILE_TTL_MS : PROFILE_RETRY_MS)) return hit.p;
    const p = extras.claudeProfile ? await extras.claudeProfile(id).catch(() => null) : null;
    profiles.set(id, { at: Date.now(), p });
    return p;
  };

  router.get('/', async (_req, res) => {
    const v = accounts.view();
    const count = (provider: AccountProvider, id: string) => (extras.threads ? { threadCount: extras.threads.pinnedTo(provider, id).length } : {});
    // Who each account is (2026-11-06): Codex from its login file; Claude from the profile call,
    // bounded so a slow network never holds the list.
    const codex = v.codex.map((a) => {
      const who = accounts.codexIdentity(a.id);
      return { ...a, ...(who?.email && !a.email ? { email: who.email } : {}), ...(who?.plan && !a.plan ? { plan: who.plan } : {}), signedIn: a.isCli ? undefined : accounts.codexSignedIn(a.id), ...count('codex', a.id) };
    });
    const claude = await Promise.all(v.claude.map(async (a) => {
      const need = !a.email || !a.plan;
      const p = need ? await Promise.race([claudeProfileOf(a.id), new Promise<null>((r) => setTimeout(() => r(null), PROFILE_WAIT_MS).unref?.())]) : null;
      return { ...a, ...(p?.email && !a.email ? { email: p.email } : {}), ...(p?.plan && !a.plan ? { plan: p.plan } : {}), ...count('claude', a.id) };
    }));
    res.json({ ...v, claude, codex });
  });

  router.patch('/:provider/:id', (req, res) => {
    const { provider, id } = req.params;
    if (!isProvider(provider)) return void res.status(404).json({ error: 'unknown provider' });
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    try {
      if (!accounts.has(provider, id)) return void res.status(404).json({ error: 'unknown account' });
      accounts.rename(provider, id, label);
      res.json(accounts.view());
    } catch (err) { res.status(400).json({ error: clientMessage(err) }); }
  });

  router.get('/:provider/:id/threads', (req, res) => {
    const { provider, id } = req.params;
    if (!isProvider(provider)) return void res.status(404).json({ error: 'unknown provider' });
    res.json(extras.threads?.pinnedTo(provider, id) ?? []);
  });

  router.post('/claude/login', async (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    try { res.json(await claudeLogin.startForAccount(label)); } catch (err) { res.status(500).json({ error: clientMessage(err) }); }
  });

  router.post('/codex', (req, res) => {
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    const a = accounts.addCodex(label);
    res.status(201).json({ id: a.id, label: a.label });
  });

  router.put('/:provider/default', (req, res) => {
    const { provider } = req.params;
    if (!isProvider(provider)) return void res.status(404).json({ error: 'unknown provider' });
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    try { accounts.setDefault(provider, id); res.json(accounts.view().defaults); } catch (err) { res.status(400).json({ error: clientMessage(err) }); }
  });

  router.delete('/:provider/:id', (req, res) => {
    const { provider, id } = req.params;
    if (!isProvider(provider)) return void res.status(404).json({ error: 'unknown provider' });
    try {
      if (!accounts.remove(provider, id)) return void res.status(404).json({ error: 'unknown account' });
      // Its threads lose the pin and run on the default from their next start (what the notice said).
      const unpinned = extras.threads?.unpin(provider, id) ?? 0;
      res.json({ unpinned });
    } catch (err) { res.status(400).json({ error: clientMessage(err) }); }
  });

  return router;
}
