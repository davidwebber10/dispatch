// packages/core/src/routes/chats.ts
// GET /api/chats: every chat thread of every project in ONE call (docs/headless-api.md, capability
// `headless-v1`). A view outside this web client (a chat page in the host platform) needs the list
// without walking each project's threads.
//
// A chat thread: not archived, an agent harness (claude-code, codex, grok, opencode) on the structured
// transport ("Pretty"), and a plain thread: no role, no runner, no agent type, no sign-in. The status is
// one of four plain values: working, needs_input, error, idle (everything else).
import type Database from 'better-sqlite3';
import { policyRouter, ownerOnly } from '../auth/route-policy.js';
import { redactKeysDeep } from '../auth/redact-keys.js';

export const CHAT_HARNESSES = ['claude-code', 'codex', 'grok', 'opencode'] as const;
export type ChatStatus = 'working' | 'needs_input' | 'error' | 'idle';

export interface ChatSummary {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  harness: string;
  status: ChatStatus;
  lastActivityAt: string;
  createdAt: string;
  model: string | null;
}

export function chatStatus(raw: string | null | undefined): ChatStatus {
  return raw === 'working' || raw === 'needs_input' || raw === 'error' ? raw : 'idle';
}

/** The chat threads, newest activity first. */
export function listChats(db: Database.Database): ChatSummary[] {
  const rows = db.prepare(`
    SELECT t.id, t.label, t.type, t.status, t.config, t.created_at, t.last_activity_at, s.id AS project_id, s.name AS project_name
    FROM terminals t JOIN sessions s ON s.id = t.session_id
    WHERE t.archived_at IS NULL AND s.archived_at IS NULL AND t.type IN (${CHAT_HARNESSES.map(() => '?').join(',')})
  `).all(...CHAT_HARNESSES) as Array<{ id: string; label: string; type: string; status: string; config: string | null; created_at: string; last_activity_at: string | null; project_id: string; project_name: string }>;
  const out: ChatSummary[] = [];
  for (const r of rows) {
    let c: Record<string, unknown> = {};
    try { const p = JSON.parse(r.config || '{}'); if (p && typeof p === 'object') c = p; } catch { /* an unreadable config reads as {} */ }
    if (c.transport !== 'structured' || c.role || c.runner || c.agentType || c.roleAuthority || c.signIn) continue;
    out.push({
      id: r.id, title: r.label, projectId: r.project_id, projectName: r.project_name, harness: r.type,
      status: chatStatus(r.status), lastActivityAt: r.last_activity_at ?? r.created_at, createdAt: r.created_at,
      model: typeof c.model === 'string' ? c.model : null,
    });
  }
  return out.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) || b.createdAt.localeCompare(a.createdAt));
}

export function createChatsRouter(db: Database.Database) {
  const router = policyRouter();
  router.get('/chats', ownerOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ chats: redactKeysDeep(listChats(db)) });
  });
  return router;
}
