import { Router } from 'express';

export interface ServerOption {
  label: string;
  origin: string;
}

/**
 * Parse the operator-configured server list from the DISPATCH_SERVERS env var.
 * Accepts either JSON (`[{"label":"MacBook","origin":"http://…:3456"}]`) or a
 * shell-friendly `Label=origin,Label2=origin2` list. Returns [] when unset.
 */
export function parseServers(raw?: string): ServerOption[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((x) => x && typeof x.label === 'string' && typeof x.origin === 'string')
        .map((x) => ({ label: String(x.label).trim(), origin: String(x.origin).trim() }));
    } catch {
      return [];
    }
  }

  return trimmed
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      if (i === -1) return null;
      const label = pair.slice(0, i).trim();
      const origin = pair.slice(i + 1).trim();
      return label && origin ? { label, origin } : null;
    })
    .filter((x): x is ServerOption => x !== null);
}

export function createServersRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json(parseServers(process.env.DISPATCH_SERVERS));
  });
  return router;
}
