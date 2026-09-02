import { Router } from 'express';
import type { RolesService, RoleStatusEntry } from '../roles/service.js';

/** Strip the role's brief body from the wire payload — the CLI reads role.md directly
 *  when it wants the content; the HTTP surface only needs to stay light. */
function serialize(entry: RoleStatusEntry): Omit<RoleStatusEntry, 'def'> & { def: Omit<RoleStatusEntry['def'], 'brief'> } {
  const { brief: _brief, ...def } = entry.def;
  return { ...entry, def };
}

export function createRolesRouter(rolesService: RolesService): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ roles: rolesService.list().map(serialize) });
  });

  router.post('/:name/enable', (req, res) => {
    try {
      res.json(serialize(rolesService.enable(req.params.name)));
    } catch (err: any) {
      res.status(err.status ?? 400).json({ error: err.message });
    }
  });

  router.post('/:name/disable', (req, res) => {
    try {
      res.json(serialize(rolesService.disable(req.params.name)));
    } catch (err: any) {
      res.status(err.status ?? 400).json({ error: err.message });
    }
  });

  return router;
}
