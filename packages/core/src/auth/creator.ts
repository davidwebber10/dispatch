import type { Request } from 'express';
import { principalOf, scopeOf } from './request-principal.js';

/**
 * Who made a request that creates something that outlives it (an integration, a schedule, an enabled role).
 * It is a record for the owner to read. It never blocks anything.
 *  - owner: a browser session, an access token or the box token.
 *  - local / tailscale: a caller with no sign-in. This Mac's browser with no access token looks the same as a
 *    thread that calls the daemon without its key, so the record cannot tell those two apart.
 *  - thread / shell: a call that carries a per-thread key, with the thread's id and name.
 *  - chat: a Chat key.
 *  - plugin: a plugin's own key (docs/superpowers/specs/2026-11-07-plugins-design.md, section 6).
 */
export type Creator =
  | { kind: 'owner' | 'local' | 'tailscale' | 'chat' }
  | { kind: 'thread' | 'shell'; terminalId: string; name: string | null }
  | { kind: 'plugin'; pluginId: string; name: string | null };

const NAME_MAX = 80;

/** The creator of the request. Never throws; a request with no principal counts as local. */
export function creatorOf(req: Request): Creator {
  let p;
  try { p = principalOf(req); } catch { return { kind: 'local' }; }
  switch (p.kind) {
    case 'owner': return { kind: 'owner' };
    case 'chat': return { kind: 'chat' };
    case 'thread':
    case 'shell': {
      let name: string | null = null;
      try { name = scopeOf(req).caller(p.terminalId)?.label?.trim().slice(0, NAME_MAX) || null; } catch { /* no scope: id only */ }
      return { kind: p.kind, terminalId: p.terminalId, name };
    }
    case 'plugin': return { kind: 'plugin', pluginId: p.pluginId, name: null };
    case 'none': return { kind: p.via === 'tailscale' ? 'tailscale' : 'local' };
  }
}

export function encodeCreator(c: Creator): string { return JSON.stringify(c); }

/** Reads a stored creator. A missing, malformed or unknown value gives null ("unknown"). */
export function decodeCreator(raw: string | null | undefined): Creator | null {
  if (!raw) return null;
  let v: any;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  switch (v.kind) {
    case 'owner': case 'local': case 'tailscale': case 'chat': return { kind: v.kind };
    case 'thread': case 'shell':
      if (typeof v.terminalId !== 'string' || !v.terminalId) return null;
      return { kind: v.kind, terminalId: v.terminalId, name: typeof v.name === 'string' && v.name ? v.name.slice(0, NAME_MAX) : null };
    case 'plugin':
      if (typeof v.pluginId !== 'string' || !v.pluginId) return null;
      return { kind: 'plugin', pluginId: v.pluginId, name: typeof v.name === 'string' && v.name ? v.name.slice(0, NAME_MAX) : null };
    default: return null;
  }
}
