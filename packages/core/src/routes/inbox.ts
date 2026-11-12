// packages/core/src/routes/inbox.ts
// The Inbox for a view OUTSIDE this web client (docs/headless-api.md section 11): the drops a thread
// handed the person with the bundled Inbox plugin (id `previews`, MCP tool `preview`), and their files.
//
// A drop is a document `preview:<id>` in the plugin's storage (written by packages/plugins/previews/mcp/
// server.mjs); its files are file references of the plugin (db/plugin-data.ts `plugin_files`), served
// from their snapshot (plugins/snapshots.ts) or, when there is none, from the project with every check
// of the plugin file route. These routes READ that storage in a fixed shape and change only the read
// state; they add nothing a thread could not already put there.
//
// Rules:
//   - The owner only (the box token through the router, or the owner's page). A thread's or a plugin's
//     key gets owner_only: an agent uses the plugin's own routes.
//   - A file is served only when the drop lists it, by its id: never a path. Every answer says
//     `nosniff` and `attachment`; HTML, SVG and other markup go out as application/octet-stream, so no
//     file a thread made runs as a page.
//   - A `secret` drop never carries its value in a list or a drop answer: `secret: {present, expired}`.
//     `GET /api/inbox/drops/:dropId/secret` gives the value to the developer profile on an explicit
//     request; the business profile refuses it (profile/business-routes.ts, rule `inbox.secret`).
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Request, Response, Router } from 'express';
import { policyRouter, ownerOnly, ownerOnlyStrict } from '../auth/route-policy.js';
import * as pluginData from '../db/plugin-data.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { insideRealRoot } from '../files/confine.js';
import { defaultSecretRoots, holdsSecret, SECRET_PATH_ERROR, type SecretRoots } from '../files/secret-paths.js';
import { PATH_REFUSALS } from '../files/path-policy.js';
import { pathPolicyFor } from '../files/path-policy-default.js';
import { isActiveContent } from '../http/active-content.js';
import { PROJECT_FILE_MIME } from '../plugins/files.js';
import { snapshotPath, removeSnapshot } from '../plugins/snapshots.js';
import { platform } from '../platform/index.js';

/** The bundled Inbox plugin's id (kept: clients and threads match on it). */
export const INBOX_PLUGIN = 'previews';
const DOC_PREFIX = 'preview:';
/** A secret's value is gone this long after it was posted (also packages/plugins/previews/mcp/kinds.mjs). */
export const SECRET_TTL_MS = 24 * 3_600_000;
const LIST_MAX = 1000;

export interface InboxFile { id: string; name: string; size: number; type: string; url: string }
export interface InboxDrop {
  id: string;
  threadId: string | null;
  threadTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  title: string;
  note: string | null;
  /** The look the thread asked for (`command`, `link`, `code`, `secret`, `steps`, `diff`, `table`, `doc`, `text`, `images`, `files`), or null: infer it. */
  kind: string | null;
  createdAt: string;
  read: boolean;
  readAt: string | null;
  files: InboxFile[];
  /** The text to show or copy. Null for a secret, always. */
  text: string | null;
  url?: string;
  commands?: string[];
  cwd?: string;
  language?: string;
  steps?: Array<{ text: string; command?: string }>;
  secret?: { present: boolean; expired: boolean };
}

interface Stored {
  id: string; sessionId?: unknown; sessionName?: unknown; terminalId?: unknown; terminalLabel?: unknown;
  title?: unknown; note?: unknown; text?: unknown; files?: unknown; createdAt?: unknown; seenAt?: unknown;
  kind?: unknown; url?: unknown; commands?: unknown; cwd?: unknown; language?: unknown; steps?: unknown; expired?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isStored = (v: unknown): v is Stored => !!v && typeof v === 'object' && typeof (v as Stored).id === 'string';

/** True when a secret drop's value is gone (removed by the plugin, or past its 24 hours). */
function secretExpired(doc: Stored, now: number): boolean {
  if (doc.expired === true || doc.text === null || doc.text === undefined) return true;
  const t = Date.parse(String(doc.createdAt ?? ''));
  return Number.isNaN(t) || now - t > SECRET_TTL_MS;
}

export interface InboxDeps {
  /** Broadcast to the events socket (the native window's Inbox follows `plugin:data`). */
  broadcast?: (event: { type: string; [k: string]: unknown }) => void;
  /** The data folder (snapshots). Default: platform.dataDir(). */
  dataDir?: string;
  /** The credential deny-list. Default: the roots of this machine. */
  secretRoots?: SecretRoots;
  /** The clock (tests). File URLs in an answer start with `/api/`: a view under a base path puts that in front. */
  now?: () => number;
}

export function createInboxRouter(db: Database.Database, deps: InboxDeps = {}): Router {
  const router = policyRouter();
  const dataDir = (): string => deps.dataDir ?? platform.dataDir();
  let roots: SecretRoots | null = deps.secretRoots ?? null;
  const secretRoots = (): SecretRoots => (roots ??= defaultSecretRoots(dataDir()));
  const filePolicy = pathPolicyFor(db);
  const now = () => (deps.now ? deps.now() : Date.now());
  const broadcast = (key: string, deleted = false) => {
    try { deps.broadcast?.({ type: 'plugin:data', id: INBOX_PLUGIN, key, ...(deleted ? { deleted: true } : {}) }); } catch { /* best effort */ }
  };

  /** One stored document as the view reads it. Live thread and project names win over the ones stored at post time. */
  const view = (doc: Stored, at: number): InboxDrop => {
    const threadId = str(doc.terminalId);
    const projectId = str(doc.sessionId);
    const thread = threadId ? terminalsDb.getById(db, threadId) : null;
    const project = projectId ? sessionsDb.getById(db, projectId) : null;
    const files = (Array.isArray(doc.files) ? doc.files : []).flatMap((f): InboxFile[] => {
      const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      const id = str(o.fileId);
      if (!id) return [];
      return [{ id, name: str(o.name) ?? 'file', size: typeof o.size === 'number' ? o.size : 0, type: str(o.mime) ?? 'application/octet-stream', url: `/api/inbox/drops/${encodeURIComponent(doc.id)}/files/${encodeURIComponent(id)}` }];
    });
    const kind = str(doc.kind);
    const out: InboxDrop = {
      id: doc.id, threadId, threadTitle: thread?.label ?? str(doc.terminalLabel), projectId, projectName: project?.name ?? str(doc.sessionName),
      title: str(doc.title) ?? 'Drop', note: str(doc.note), kind, createdAt: str(doc.createdAt) ?? '',
      read: !!str(doc.seenAt), readAt: str(doc.seenAt), files,
      text: kind === 'secret' ? null : str(doc.text),
    };
    if (kind === 'secret') {
      const expired = secretExpired(doc, at);
      out.secret = { present: !expired, expired };
      return out;
    }
    if (typeof doc.url === 'string') out.url = doc.url;
    if (Array.isArray(doc.commands)) out.commands = doc.commands.filter((c): c is string => typeof c === 'string');
    if (typeof doc.cwd === 'string') out.cwd = doc.cwd;
    if (typeof doc.language === 'string') out.language = doc.language;
    if (Array.isArray(doc.steps)) out.steps = doc.steps.flatMap((s) => (s && typeof s === 'object' && typeof (s as any).text === 'string' ? [{ text: (s as any).text, ...(typeof (s as any).command === 'string' ? { command: (s as any).command } : {}) }] : []));
    return out;
  };

  const all = (): Stored[] => pluginData.listDocs(db, INBOX_PLUGIN, { values: true })
    .filter((d) => d.key.startsWith(DOC_PREFIX) && isStored(d.value) && (d.value as Stored).id === d.key.slice(DOC_PREFIX.length))
    .map((d) => d.value as Stored);
  const one = (dropId: string): Stored | null => {
    const doc = pluginData.getDoc(db, INBOX_PLUGIN, `${DOC_PREFIX}${dropId}`);
    return doc && isStored(doc.value) && doc.value.id === dropId ? doc.value : null;
  };
  const newestFirst = (a: Stored, b: Stored) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  const notFound = (res: Response) => res.status(404).json({ error: 'drop not found' });
  const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

  // The list, newest first. Filters: threadId, projectId, unread=1; a page: limit (default 200, at most 1000) and before=<createdAt>.
  router.get('/inbox', ownerOnly, (req, res) => {
    const q = req.query;
    const limit = Math.max(1, Math.min(LIST_MAX, Number(q.limit) || 200));
    const at = now();
    let docs = all();
    const unread = docs.filter((d) => !str(d.seenAt)).length;
    if (typeof q.threadId === 'string') docs = docs.filter((d) => d.terminalId === q.threadId);
    if (typeof q.projectId === 'string') docs = docs.filter((d) => d.sessionId === q.projectId);
    if (q.unread === '1') docs = docs.filter((d) => !str(d.seenAt));
    if (typeof q.before === 'string') { const before = q.before; docs = docs.filter((d) => String(d.createdAt ?? '') < before); }
    docs.sort(newestFirst);
    noStore(res);
    res.json({ drops: docs.slice(0, limit).map((d) => view(d, at)), hasMore: docs.length > limit, unread });
  });

  // Unread counts: all, per thread, per project.
  router.get('/inbox/unread', ownerOnly, (_req, res) => {
    const byThread: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    let total = 0;
    for (const d of all()) {
      if (str(d.seenAt)) continue;
      total++;
      const t = str(d.terminalId); const p = str(d.sessionId);
      if (t) byThread[t] = (byThread[t] ?? 0) + 1;
      if (p) byProject[p] = (byProject[p] ?? 0) + 1;
    }
    noStore(res);
    res.json({ total, byThread, byProject });
  });

  router.get('/inbox/drops/:dropId', ownerOnly, (req, res) => {
    const doc = one(req.params.dropId);
    if (!doc) return void notFound(res);
    noStore(res);
    res.json({ drop: view(doc, now()) });
  });

  // Mark read: one drop, or every unread drop (of a thread or a project when the body names one).
  const markRead = (doc: Stored): void => {
    if (str(doc.seenAt)) return;
    const key = `${DOC_PREFIX}${doc.id}`;
    const stored = pluginData.getDoc(db, INBOX_PLUGIN, key);
    pluginData.setDoc(db, INBOX_PLUGIN, key, { ...doc, seenAt: new Date(now()).toISOString() }, stored?.writer ?? null);
    broadcast(key);
  };
  router.post('/inbox/drops/:dropId/read', ownerOnly, (req, res) => {
    const doc = one(req.params.dropId);
    if (!doc) return void notFound(res);
    markRead(doc);
    noStore(res);
    res.json({ drop: view(one(req.params.dropId) ?? doc, now()) });
  });
  router.post('/inbox/read', ownerOnly, (req, res) => {
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as { threadId?: unknown; projectId?: unknown };
    const docs = all().filter((d) => !str(d.seenAt)
      && (typeof b.threadId !== 'string' || d.terminalId === b.threadId)
      && (typeof b.projectId !== 'string' || d.sessionId === b.projectId));
    for (const d of docs) markRead(d);
    noStore(res);
    res.json({ marked: docs.length });
  });

  // Delete a drop and its files (their references and snapshots), as the native Inbox does.
  router.delete('/inbox/drops/:dropId', ownerOnly, (req, res) => {
    const doc = one(req.params.dropId);
    if (!doc) return void notFound(res);
    for (const f of Array.isArray(doc.files) ? doc.files : []) {
      const id = str((f as Record<string, unknown> | null)?.fileId);
      if (!id) continue;
      const snap = pluginData.getFileSnapshot(db, INBOX_PLUGIN, id);
      if (pluginData.removeFile(db, INBOX_PLUGIN, id)) removeSnapshot(dataDir(), INBOX_PLUGIN, snap);
    }
    pluginData.deleteDoc(db, INBOX_PLUGIN, `${DOC_PREFIX}${doc.id}`);
    broadcast(`${DOC_PREFIX}${doc.id}`, true);
    res.status(204).end();
  });

  // A secret's value, on an explicit request for that one drop. Refused for the business profile.
  router.get('/inbox/drops/:dropId/secret', ownerOnlyStrict, (req, res) => {
    const doc = one(req.params.dropId);
    if (!doc || doc.kind !== 'secret') return void notFound(res);
    noStore(res);
    if (secretExpired(doc, now())) return void res.status(410).json({ error: 'secret_expired', message: 'The value was removed 24 hours after it was posted.' });
    res.json({ value: doc.text });
  });

  // One file of one drop, by id. Only a file the drop lists; never a path.
  router.get('/inbox/drops/:dropId/files/:fileId', ownerOnly, async (req: Request, res: Response) => {
    const doc = one(req.params.dropId);
    const fileId = req.params.fileId;
    const listed = doc && Array.isArray(doc.files) && doc.files.some((f) => (f as Record<string, unknown> | null)?.fileId === fileId);
    const file = listed ? pluginData.getFile(db, INBOX_PLUGIN, fileId) : null;
    if (!doc || !file) return void res.status(404).json({ error: 'file not found' });
    let source: string | null = null;
    const snap = snapshotPath(dataDir(), INBOX_PLUGIN, pluginData.getFileSnapshot(db, INBOX_PLUGIN, file.fileId));
    if (snap && fs.existsSync(snap)) source = snap; // checked when it was made; never changes
    else {
      const session = sessionsDb.getById(db, file.sessionId);
      if (!session || !insideRealRoot(session.working_dir, file.path) || !fs.existsSync(file.path)) return void res.status(404).json({ error: 'file not found' });
      if (await holdsSecret(file.path, secretRoots()).catch(() => true)) return void res.status(403).json({ error: SECRET_PATH_ERROR });
      let why = filePolicy.problem(file.path, { project: session.working_dir, use: 'read' });
      try { why ??= filePolicy.openedProblem(fs.statSync(file.path), fs.realpathSync(file.path)); } catch { /* gone: sendFile answers */ }
      if (why) return void res.status(403).json({ error: PATH_REFUSALS[why], code: 'path_refused', reason: why });
      source = file.path;
    }
    const mime = PROJECT_FILE_MIME[path.extname(source).toLowerCase()] ?? 'application/octet-stream';
    const type = isActiveContent(mime) ? 'application/octet-stream' : mime;
    const ascii = file.name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'file';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(type);
    res.sendFile(source, { headers: { 'Content-Type': type } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'file not found' });
    });
  });

  return router;
}
