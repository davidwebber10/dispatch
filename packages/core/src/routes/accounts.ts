import type { Router } from 'express';
import { policyRouter } from '../auth/route-policy.js';
import type { ClaudeLoginService } from '../auth/claude-login.js';
import { ACCOUNT_PROVIDERS, type AccountProvider, type AccountsStore } from '../auth/accounts.js';
import { clientMessage } from '../http/client-message.js';

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
export function createAccountsRouter(accounts: AccountsStore, claudeLogin: ClaudeLoginService): Router {
  const router = policyRouter();

  router.get('/', (_req, res) => {
    const v = accounts.view();
    // A Codex folder with no auth.json yet is "not signed in": the list says so.
    res.json({ ...v, codex: v.codex.map((a) => ({ ...a, signedIn: a.isCli ? undefined : accounts.codexSignedIn(a.id) })) });
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
      res.status(204).end();
    } catch (err) { res.status(400).json({ error: clientMessage(err) }); }
  });

  return router;
}
