import { Router } from 'express';
import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';

export interface ServerOption {
  label: string;
  origin: string;
}

const STATE_KEY = 'servers';

function normalizeOrigin(o: string): string {
  return o.trim().replace(/\/+$/, '');
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
        .map((x) => ({ label: String(x.label).trim(), origin: normalizeOrigin(String(x.origin)) }));
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
      const origin = normalizeOrigin(pair.slice(i + 1));
      return label && origin ? { label, origin } : null;
    })
    .filter((x): x is ServerOption => x !== null);
}

/**
 * The live server list. Once the user customizes it (add/remove via the UI) it is
 * persisted in app_state and becomes authoritative; until then we fall back to the
 * operator's DISPATCH_SERVERS env default.
 */
function readServers(db: Database.Database): ServerOption[] {
  const stored = appState.get(db, STATE_KEY);
  if (stored != null) {
    try {
      const arr = JSON.parse(stored);
      if (Array.isArray(arr)) {
        return arr
          .filter((x) => x && typeof x.label === 'string' && typeof x.origin === 'string')
          .map((x) => ({ label: String(x.label).trim(), origin: normalizeOrigin(String(x.origin)) }));
      }
    } catch { /* fall through to env */ }
  }
  return parseServers(process.env.DISPATCH_SERVERS);
}

function writeServers(db: Database.Database, list: ServerOption[]): void {
  appState.set(db, STATE_KEY, JSON.stringify(list));
}

export function createServersRouter(db?: Database.Database): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(db ? readServers(db) : parseServers(process.env.DISPATCH_SERVERS));
  });

  router.post('/', (req, res) => {
    if (!db) { res.status(503).json({ error: 'server list is not writable' }); return; }
    const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    const origin = typeof req.body?.origin === 'string' ? normalizeOrigin(req.body.origin) : '';
    if (!label || !origin) { res.status(400).json({ error: 'label and origin are required' }); return; }
    if (!/^https?:\/\/.+/i.test(origin)) { res.status(400).json({ error: 'origin must be an http(s) URL' }); return; }
    const list = readServers(db).filter((s) => s.origin !== origin);
    list.push({ label, origin });
    writeServers(db, list);
    res.json(list);
  });

  router.delete('/', (req, res) => {
    if (!db) { res.status(503).json({ error: 'server list is not writable' }); return; }
    const origin = typeof req.query.origin === 'string' ? normalizeOrigin(req.query.origin) : '';
    if (!origin) { res.status(400).json({ error: 'origin query param is required' }); return; }
    writeServers(db, readServers(db).filter((s) => s.origin !== origin));
    res.json(readServers(db));
  });

  return router;
}
