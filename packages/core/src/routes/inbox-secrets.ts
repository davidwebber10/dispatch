import type { Router, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { policyRouter, ownerOnlyStrict, keyRoute } from '../auth/route-policy.js';
import { allowRule } from '../auth/key-rules.js';
import { principalOf, scopeOf } from '../auth/request-principal.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { defaultSecretRoots, type SecretRoots } from '../files/secret-paths.js';
import type { SecretsService } from '../secrets/service.js';
import {
  InboxSecretStore, normalizeSecretId, inboxSecretNow, DotenvError, ENV_NAME_RE, SECRET_VALUE_MAX, SECRET_NAME_MAX,
  type SecretDestination, type InboxSecretRecord,
} from '../inbox/secret-store.js';
import { writeSecretFile, SecretFileError } from '../inbox/write-file.js';

/**
 * Inbox → Send a secret (2026-11-12), the routes:
 *
 *   POST   /api/inbox/secrets          owner: { name, value, sessionId? , terminalId?, allowReveal? } → the record and its ID
 *   GET    /api/inbox/secrets          owner: the records (?sessionId=, ?terminalId=); never a value
 *   DELETE /api/inbox/secrets/:id      owner: the record and the stored value
 *   POST   /api/inbox/secrets/use      a thread key: { id, file | doppler | reveal } — the DAEMON writes the value
 *
 * The value is in no answer (except `reveal`, when the owner allowed it), no error, no log line.
 */

/** Failed lookups a thread may make in the window before it is refused (so an ID cannot be guessed). */
export const LOOKUP_FAILURES_MAX = 10;
export const LOOKUP_WINDOW_MS = 10 * 60_000;

/** Doppler names: upper-case letters, digits and underscores, not starting with a digit. */
const DOPPLER_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export interface InboxSecretsOptions {
  dataDir: string;
  secrets: Pick<SecretsService, 'setSecret' | 'status'>;
  secretRoots?: SecretRoots;
  /** Tells the open pages that the list changed (no value in it). */
  broadcast?: (event: { type: 'inbox:secrets'; id: string }) => void;
}

/** A message with every copy of the value taken out (an upstream error may repeat what it was sent). */
const scrub = (msg: string, value: string): string => (value ? msg.split(value).join('[the value]') : msg);

type Parsed = { dest: SecretDestination } | { error: string };

function parseDestination(body: Record<string, unknown>): Parsed {
  const picked = (['file', 'doppler', 'reveal'] as const).filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== false);
  if (picked.length !== 1) return { error: 'give exactly one destination: `file` ({ path, name? }), `doppler` ({ name }) or `reveal: true`' };
  if (picked[0] === 'reveal') return body.reveal === true ? { dest: { kind: 'reveal' } } : { error: '`reveal` must be true' };
  if (picked[0] === 'doppler') {
    const d = body.doppler as { name?: unknown };
    const name = d && typeof d === 'object' && typeof d.name === 'string' ? d.name.trim() : '';
    if (!DOPPLER_NAME_RE.test(name)) return { error: '`doppler.name` must be upper-case letters, digits and underscores (e.g. STRIPE_KEY)' };
    return { dest: { kind: 'doppler', name } };
  }
  const f = body.file as { path?: unknown; name?: unknown };
  if (!f || typeof f !== 'object' || typeof f.path !== 'string' || !f.path.trim()) return { error: '`file.path` must be a path inside the project (e.g. .env.local)' };
  if (f.name !== undefined && f.name !== null) {
    if (typeof f.name !== 'string' || !ENV_NAME_RE.test(f.name.trim())) return { error: '`file.name` must be letters, digits and underscores, not starting with a digit (e.g. STRIPE_KEY)' };
    return { dest: { kind: 'file', path: f.path.trim(), name: f.name.trim() } };
  }
  return { dest: { kind: 'file', path: f.path.trim() } };
}

export function createInboxSecretsRouter(db: Database.Database, opts: InboxSecretsOptions): Router {
  const router = policyRouter();
  const store = new InboxSecretStore(db, opts.dataDir);
  let roots: SecretRoots | null = opts.secretRoots ?? null;
  const secretRoots = (): SecretRoots => (roots ??= defaultSecretRoots(opts.dataDir));
  const changed = (id: string) => { try { opts.broadcast?.({ type: 'inbox:secrets', id }); } catch { /* a page reloads the list on open */ } };

  // ── failed lookups, per thread (in memory; a restart forgets them) ──
  const failures = new Map<string, number[]>();
  const recent = (terminalId: string): number[] => {
    const since = inboxSecretNow() - LOOKUP_WINDOW_MS;
    const list = (failures.get(terminalId) ?? []).filter((t) => t > since);
    if (list.length) failures.set(terminalId, list); else failures.delete(terminalId);
    return list;
  };
  const fail = (terminalId: string) => {
    if (failures.size > 5000) failures.clear();
    failures.set(terminalId, [...recent(terminalId), inboxSecretNow()]);
  };
  /** One use at a time for each ID: a second call while the first writes is refused. */
  const busy = new Set<string>();

  router.post('/inbox/secrets', ownerOnlyStrict, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return void res.status(400).json({ error: 'name is required (e.g. "Stripe key")' });
    if (name.length > SECRET_NAME_MAX) return void res.status(400).json({ error: `the name is at most ${SECRET_NAME_MAX} characters` });
    if (typeof b.value !== 'string' || b.value.length === 0) return void res.status(400).json({ error: 'value is required' });
    if (b.value.length > SECRET_VALUE_MAX) return void res.status(400).json({ error: 'the value is at most 64 KB' });
    let sessionId = typeof b.sessionId === 'string' && b.sessionId ? b.sessionId : null;
    const terminalId = typeof b.terminalId === 'string' && b.terminalId ? b.terminalId : null;
    if (terminalId) {
      const t = terminalsDb.getById(db, terminalId);
      if (!t) return void res.status(404).json({ error: 'thread not found' });
      if (sessionId && sessionId !== t.session_id) return void res.status(400).json({ error: 'the thread is not in that project' });
      sessionId = t.session_id;
    }
    if (!sessionId) return void res.status(400).json({ error: 'a project (sessionId) or a thread (terminalId) is required' });
    if (!sessionsDb.getById(db, sessionId)) return void res.status(404).json({ error: 'project not found' });
    let rec: InboxSecretRecord;
    try { rec = store.create({ name, value: b.value, sessionId, terminalId, allowReveal: b.allowReveal === true }); }
    catch (e) { return void res.status(500).json({ error: scrub(e instanceof Error ? e.message : 'could not store the secret', b.value) }); }
    changed(rec.id);
    res.status(201).json(rec);
  });

  router.get('/inbox/secrets', ownerOnlyStrict, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const q = (v: unknown) => (typeof v === 'string' && v ? v : null);
    res.json({ secrets: store.list({ sessionId: q(req.query.sessionId), terminalId: q(req.query.terminalId) }) });
  });

  router.delete('/inbox/secrets/:id', ownerOnlyStrict, (req, res) => {
    const id = normalizeSecretId(req.params.id);
    if (!id || !store.remove(id)) return void res.status(404).json({ error: 'secret not found' });
    changed(id);
    res.status(204).end();
  });

  router.post('/inbox/secrets/use', keyRoute({ thread: allowRule, roleRun: allowRule }), async (req: Request, res: Response) => {
    let p;
    try { p = principalOf(req); } catch { p = null; }
    if (!p || p.kind !== 'thread') return void res.status(403).json({ error: 'Only a thread uses an Inbox secret: the inbox_secret tool sends its key.' });
    const caller = scopeOf(req).caller(p.terminalId);
    if (!caller) return void res.status(401).json({ error: 'auth_required' });
    const b = (req.body ?? {}) as Record<string, unknown>;

    if (recent(caller.id).length >= LOOKUP_FAILURES_MAX) {
      return void res.status(429).json({ error: `Too many failed secret lookups from this thread. Wait 10 minutes, and ask the owner for the right ID.` });
    }
    const parsed = parseDestination(b);
    if ('error' in parsed) return void res.status(400).json({ error: parsed.error });
    const { dest } = parsed;

    // One answer for "no such ID" and "an ID of another scope": the refusal tells nothing about other projects.
    const shown = typeof b.id === 'string' ? b.id.trim().slice(0, 20).replace(/[^A-Za-z0-9-]/g, '') : '';
    const unknown = () => { fail(caller.id); res.status(404).json({ error: `No secret with the ID ${shown || '(none)'} is waiting for this thread. Check the ID with the owner.` }); };
    const id = normalizeSecretId(b.id);
    if (!id) return void unknown();
    const rec = store.get(id);
    if (!rec || rec.sessionId !== caller.sessionId || (rec.terminalId !== null && rec.terminalId !== caller.id)) return void unknown();
    if (rec.state === 'used') { fail(caller.id); return void res.status(410).json({ error: `The secret ${id} was already used (one use only). Ask the owner to send it again.` }); }
    if (rec.state === 'expired') { fail(caller.id); return void res.status(410).json({ error: `The secret ${id} expired (24 hours after it was sent). Ask the owner to send it again.` }); }
    if (dest.kind === 'reveal' && !rec.allowReveal) {
      return void res.status(403).json({ error: 'The owner did not allow this thread to read the secret. Write it to a file instead (file: { path: ".env.local", name: "STRIPE_KEY" }) or to Doppler (doppler: { name: "STRIPE_KEY" }), and use it by reference.' });
    }
    if (busy.has(id)) return void res.status(409).json({ error: `The secret ${id} is in use by another call. Try again in a moment.` });
    busy.add(id);
    let value = '';
    try {
      const v = store.readValue(id);
      if (v === null) return void res.status(410).json({ error: `The secret ${id} is gone. Ask the owner to send it again.` });
      value = v;
      const by = { terminalId: caller.id, label: caller.label ?? null };
      if (dest.kind === 'reveal') {
        store.markUsed(id, by, dest);
        changed(id);
        res.setHeader('Cache-Control', 'no-store');
        return void res.json({ ok: true, value, message: `The value of "${rec.name}" is in \`value\`. It was removed from the Inbox. Never print it or put it in the chat; write it where it is needed.` });
      }
      if (dest.kind === 'doppler') {
        try { await opts.secrets.setSecret(dest.name, value); } catch (e) {
          const msg = scrub(e instanceof Error ? e.message : String(e), value);
          if (/not connected|project and config are required/i.test(msg)) return void res.status(400).json({ error: 'Doppler is not connected in Dispatch. Write the secret to a file instead, or ask the owner to connect Doppler in Settings.' });
          if (/read-only/i.test(msg)) return void res.status(400).json({ error: 'Doppler is read-only in Dispatch. Write the secret to a file instead, or ask the owner to turn off read-only in Settings.' });
          return void res.status(502).json({ error: `Doppler did not take the secret: ${msg.slice(0, 300)}. The secret is still in the Inbox.` });
        }
        store.markUsed(id, by, dest);
        changed(id);
        const st = opts.secrets.status();
        const where = st.project && st.config ? ` (project ${st.project}, config ${st.config})` : '';
        return void res.json({ ok: true, message: `Set ${dest.name} in Doppler${where}. The value was removed from the Inbox. Use it by reference: doppler run -- <command>.` });
      }
      const session = sessionsDb.getById(db, caller.sessionId);
      if (!session) return void res.status(404).json({ error: 'the project of this thread is gone' });
      let written;
      try {
        written = await writeSecretFile({ root: session.working_dir, requested: dest.path, name: dest.name, value, roots: secretRoots() });
      } catch (e) {
        if (e instanceof SecretFileError) return void res.status(e.status).json({ error: `${e.message}: ${dest.path}. The secret is still in the Inbox.` });
        if (e instanceof DotenvError) return void res.status(400).json({ error: `${e.message}. The secret is still in the Inbox.` });
        return void res.status(500).json({ error: `could not write the file: ${scrub(e instanceof Error ? e.message : String(e), value).slice(0, 200)}. The secret is still in the Inbox.` });
      }
      store.markUsed(id, by, { kind: 'file', path: written.rel, ...(dest.name ? { name: dest.name } : {}) });
      changed(id);
      const what = dest.name ? `Wrote ${dest.name} to ${written.rel}` : `Wrote the secret to ${written.rel}`;
      const git = written.gitIgnored === false ? ` Warning: ${written.rel} is not ignored by git. Add it to .gitignore before you commit.` : '';
      const how = dest.name ? ` Use it by reference (load ${written.rel} in the command's environment); never print it.` : ' Use the file by its path; never print it.';
      return void res.json({ ok: true, path: written.rel, message: `${what} (0600). The value was removed from the Inbox.${git}${how}` });
    } finally {
      busy.delete(id);
      value = '';
    }
  });

  return router;
}
