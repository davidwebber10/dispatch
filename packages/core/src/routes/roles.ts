import type { Router } from 'express';
import { keyRoute, policyRouter } from '../auth/route-policy.js';
import { allowRule } from '../auth/key-rules.js';
import { creatorOf } from '../auth/creator.js';
import type { RolesService, RoleStatusEntry } from '../roles/service.js';
import { clientMessage } from '../http/client-message.js';

/** Strip the role's brief body from the wire payload — the CLI reads role.md directly
 *  when it wants the content; the HTTP surface only needs to stay light. */
function serialize(entry: RoleStatusEntry): Omit<RoleStatusEntry, 'def'> & { def: Omit<RoleStatusEntry['def'], 'brief'> } {
  const { brief: _brief, ...def } = entry.def;
  return { ...entry, def };
}

export function createRolesRouter(rolesService: RolesService): Router {
  const router = policyRouter();

  router.get('/', (_req, res) => {
    res.json({ roles: rolesService.list().map(serialize) });
  });

  // SEC-20: a thread with its own key may create this (never blocked); the route records the thread as the creator.
  // Only `thread` has a rule, so a role run, a shell and Chat stay owner only and a scheduled run cannot add the next schedule.
  router.post('/:name/enable', keyRoute({ thread: allowRule }), (req, res) => {
    try {
      res.json(serialize(rolesService.enable(req.params.name, creatorOf(req))));
    } catch (err: any) {
      res.status(err.status ?? 400).json({ error: clientMessage(err) });
    }
  });

  router.post('/:name/disable', (req, res) => {
    try {
      res.json(serialize(rolesService.disable(req.params.name)));
    } catch (err: any) {
      res.status(err.status ?? 400).json({ error: clientMessage(err) });
    }
  });

  return router;
}
