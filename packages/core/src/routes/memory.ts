import type { Request, Response, Router } from 'express';
import { keyRoute, ownerOnlyStrict, policyRouter, type Rule } from '../auth/route-policy.js';
import { MemoryError, isScope, type MemoryScope } from '../db/memory.js';
import type { MemoryService, ThreadCaller } from '../memory/service.js';
import { clientMessage } from '../http/client-message.js';

/**
 * /api/memory (spec 2026-11-17-memory-design.md, part 6; phase 1 routes).
 *
 *   the person (owner)   every route. Writes from the page are ownerOnlyStrict.
 *   a thread key         GET /pages, /pages/:id, /read, /search and POST /notes, always inside
 *                        "you" and its own project's scope. The rule takes the caller from the key,
 *                        never from the body, and puts it in res.locals.memoryCaller.
 *
 * Every route has a row in profile/business-routes.ts (refused there: memory waits for the host).
 */

/** A thread key (also a role run) may use the route; its project and harness come from the daemon's records. */
export const memoryThreadRule: Rule = (req, ctx) => {
  if (!ctx.caller) return { ok: false, status: 403, error: 'owner_only', message: 'Only a thread may use memory with a key.' };
  if (req.res) req.res.locals.memoryCaller = { terminalId: ctx.caller.id, sessionId: ctx.caller.sessionId, harness: ctx.caller.type } satisfies ThreadCaller;
  return { ok: true };
};
const threadKey = keyRoute({ thread: memoryThreadRule, roleRun: memoryThreadRule });

const callerOf = (res: Response): ThreadCaller | null => (res.locals.memoryCaller as ThreadCaller | undefined) ?? null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const idOf = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new MemoryError('bad id', 404);
  return n;
};
const scopeParam = (v: unknown): MemoryScope => {
  if (!isScope(v)) throw new MemoryError('bad scope: "you" or "project:<project id>"');
  return v;
};

export function createMemoryRouter(svc: MemoryService): Router {
  const router = policyRouter();

  const handle = (status: number, run: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
    try {
      const out = run(req, res);
      res.status(status).json(out ?? { ok: true });
    } catch (err) {
      if (err instanceof MemoryError) { res.status(err.status).json({ error: err.message }); return; }
      console.error('[memory] request failed:', err);
      res.status(500).json({ error: clientMessage(err) });
    }
  };
  /** A thread may touch only You and its own project; the person anything. */
  const guardScope = (res: Response, scope: MemoryScope) => {
    const caller = callerOf(res);
    if (caller) svc.checkThreadScope(caller, scope);
  };
  const threadNeedsMemory = (res: Response) => {
    if (callerOf(res) && !svc.available()) throw new MemoryError('Memory is off.', 403);
  };

  router.get('/scopes', handle(200, () => ({ scopes: svc.scopes() })));

  router.get('/pages', threadKey, handle(200, (req, res) => {
    threadNeedsMemory(res);
    const scope = scopeParam(req.query.scope);
    guardScope(res, scope);
    return { pages: svc.listPages(scope) };
  }));
  router.get('/pages/:id', threadKey, handle(200, (req, res) => {
    threadNeedsMemory(res);
    const out = svc.page(idOf(req.params.id));
    guardScope(res, out.page.scope);
    return out;
  }));
  router.post('/pages', ownerOnlyStrict, handle(201, (req) => {
    const b = req.body ?? {};
    return svc.createPage({ scope: scopeParam(b.scope), slug: String(b.slug ?? ''), description: b.description, body: b.body, pinned: b.pinned === true });
  }));
  router.put('/pages/:id', ownerOnlyStrict, handle(200, (req) => {
    const b = req.body ?? {};
    return svc.updatePage(idOf(req.params.id), {
      description: b.description, body: b.body, expectedSha: str(b.expectedSha), pinned: typeof b.pinned === 'boolean' ? b.pinned : undefined,
    });
  }));
  router.delete('/pages/:id', ownerOnlyStrict, handle(200, (req) => svc.deletePage(idOf(req.params.id))));
  router.get('/pages/:id/versions', handle(200, (req) => ({ versions: svc.versions(idOf(req.params.id)) })));
  router.post('/pages/:id/restore', ownerOnlyStrict, handle(200, (req) => svc.restore(idOf(req.params.id), idOf(req.body?.versionId))));

  // memory_read: a page by slug, in the thread's own scopes (the person may name any scope).
  router.get('/read', threadKey, handle(200, (req, res) => {
    const slug = String(req.query.slug ?? '');
    const caller = callerOf(res);
    if (caller) {
      const which = req.query.scope === 'you' || req.query.scope === 'project' ? req.query.scope : undefined;
      return svc.readForThread(caller, slug, which);
    }
    const scope = scopeParam(req.query.scope);
    const page = svc.listPages(scope).find((p) => p.slug === slug && p.status === 'active');
    if (!page) throw new MemoryError(`no page "${slug}"`, 404);
    return svc.page(page.id);
  }));

  router.get('/notes', handle(200, (req) => {
    const status = req.query.status === 'new' || req.query.status === 'used' ? req.query.status : 'live';
    return { notes: svc.notes(scopeParam(req.query.scope), status) };
  }));
  // A thread's `remember`, or a note the person writes.
  router.post('/notes', threadKey, handle(201, (req, res) => {
    const b = req.body ?? {};
    const caller = callerOf(res);
    if (caller) return svc.remember(caller, { text: b.text, about: b.about, scope: b.scope });
    return svc.addUserNote({ scope: scopeParam(b.scope), text: String(b.text ?? ''), about: str(b.about) ?? null });
  }));
  router.delete('/notes/:id', ownerOnlyStrict, handle(200, (req) => { svc.deleteNote(idOf(req.params.id)); }));

  router.get('/search', threadKey, handle(200, (req, res) => {
    threadNeedsMemory(res);
    const q = String(req.query.q ?? '');
    const limit = Number(req.query.limit) || 20;
    const caller = callerOf(res);
    // `in=conversations`: the words of past threads (layer 1), not pages and notes.
    if (req.query.in === 'conversations') return { results: svc.searchConversations(q, caller, str(req.query.project) || null, limit) };
    if (caller) return { results: svc.search(q, svc.readableScopes(caller.sessionId), limit) };
    const scopes = req.query.scope === undefined ? svc.allScopes() : [scopeParam(req.query.scope)];
    return { results: svc.search(q, scopes, limit) };
  }));

  // What a thread of this project gets, exactly ("What threads see").
  router.get('/block', handle(200, (req) => {
    const project = str(req.query.project) || null;
    const text = svc.block(project, str(req.query.harness));
    return { text, chars: text.length, cap: svc.settings().blockChars };
  }));

  router.get('/settings', handle(200, () => svc.settings()));
  router.put('/settings', ownerOnlyStrict, handle(200, (req) => svc.updateSettings(req.body)));

  // Off the record, for one thread (the thread menu).
  router.get('/threads/:terminalId', handle(200, (req) => ({ offRecord: svc.offRecord(req.params.terminalId) })));
  router.put('/threads/:terminalId', ownerOnlyStrict, handle(200, (req) => {
    if (typeof req.body?.offRecord !== 'boolean') throw new MemoryError('offRecord is true or false');
    svc.setOffRecord(req.params.terminalId, req.body.offRecord);
    return { offRecord: req.body.offRecord };
  }));

  return router;
}
