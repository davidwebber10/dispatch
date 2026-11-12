import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Inbox → Send a secret (2026-11-12). The owner hands a thread an API key without the chat: the daemon keeps the
 * value and answers a short ID; a thread in the scope uses the ID once (`inbox_secret` of the Inbox plugin), and
 * the daemon writes the value where the thread asks (a file of the project, Doppler).
 *
 * Where things live:
 * - The record: the table `inbox_secrets` (no value in it).
 * - The value: the file `<dataDir>/inbox-secrets/<id>`, mode 0600, in a 0700 folder. That folder is on the
 *   credential deny-list of the file routes (files/secret-paths.ts), so no route serves it. It is NOT in a plugin
 *   document: a thread with a storage grant can read those.
 *
 * The value goes at its first use, or when the store is read after its 24 hours. No timer (owner rule): every
 * read of the store (list, get, a lookup, a create) deletes the value files that must go.
 */

/** No 0, O, 1, I or L: an ID is read off a phone and typed by a model. */
export const SECRET_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SECRET_ID_LENGTH = 6;
/** An unused secret is gone this long after it was sent. */
export const SECRET_TTL_MS = 24 * 3_600_000;
/** The largest value: a long token, a PEM key. */
export const SECRET_VALUE_MAX = 64 * 1024;
export const SECRET_NAME_MAX = 100;
const ID_RE = new RegExp(`^[${SECRET_ID_ALPHABET}]{${SECRET_ID_LENGTH}}$`);

let clock: () => number = Date.now;
/** Test seam: the clock of the expiry and of the lookup rate limit. No argument: the real clock. */
export function configureInboxSecretClock(now?: () => number): void { clock = now ?? Date.now; }
export const inboxSecretNow = (): number => clock();

export function newSecretId(): string {
  let id = '';
  for (let i = 0; i < SECRET_ID_LENGTH; i++) id += SECRET_ID_ALPHABET[randomInt(SECRET_ID_ALPHABET.length)];
  return id;
}

/** The ID as a model may type it (lower case, with a space or a dash), in its stored form; null when it cannot be one. */
export function normalizeSecretId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.replace(/[\s-]/g, '').toUpperCase();
  return ID_RE.test(id) ? id : null;
}

// ── dotenv ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export class DotenvError extends Error {}

/**
 * One `NAME=value` line. A value of plain characters is bare; any other value is quoted so that dotenv reads it
 * back as it is: single quotes (literal), else double quotes (no backslash or `$` in it), else backticks. A value
 * with a line break, or with all three quote marks, cannot be one line.
 */
export function dotenvLine(name: string, value: string): string {
  if (!ENV_NAME_RE.test(name)) throw new DotenvError('the name must be letters, digits and underscores, and not start with a digit (e.g. STRIPE_KEY)');
  if (/[\r\n]/.test(value)) throw new DotenvError('this value has a line break, so it cannot be one line of a dotenv file: write it as a whole file (leave out `name`), or to Doppler');
  if (/^[A-Za-z0-9_\-./:+@=,~%^]*$/.test(value)) return `${name}=${value}`;
  if (!value.includes("'")) return `${name}='${value}'`;
  if (!/["\\$]/.test(value)) return `${name}="${value}"`;
  if (!value.includes('`')) return `${name}=\`${value}\``;
  throw new DotenvError('this value has every kind of quote mark, so it cannot be one line of a dotenv file: write it as a whole file (leave out `name`), or to Doppler');
}

/** The file with `NAME=value` in it: the first `NAME=` line (with `export ` kept) is replaced and any later one removed; else the line is added at the end. */
export function upsertDotenv(content: string, name: string, value: string): string {
  const line = dotenvLine(name, value);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content === '' ? [] : content.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const match = new RegExp(`^(\\s*export\\s+)?${name}\\s*=`);
  let done = false;
  const out: string[] = [];
  for (const l of lines) {
    const m = match.exec(l);
    if (!m) { out.push(l); continue; }
    if (done) continue;
    out.push(m[1] ? `export ${line}` : line);
    done = true;
  }
  if (!done) out.push(line);
  return out.join(eol) + eol;
}

// ── the store ──────────────────────────────────────────────────────────────────────────────────────────────────

export type SecretDestination =
  | { kind: 'file'; path: string; name?: string }
  | { kind: 'doppler'; name: string }
  | { kind: 'reveal' };

export interface InboxSecretRecord {
  id: string;
  sessionId: string;
  /** Set: only this thread may use it. Null: any thread of the project. */
  terminalId: string | null;
  terminalLabel: string | null;
  name: string;
  allowReveal: boolean;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
  usedByLabel: string | null;
  usedTo: SecretDestination | null;
  state: 'waiting' | 'used' | 'expired';
}

interface Row {
  id: string; session_id: string; terminal_id: string | null; name: string; allow_reveal: number;
  created_at: string; expires_at: string; used_at: string | null; used_by: string | null; used_by_label: string | null; used_to: string | null;
  terminal_label?: string | null;
}

const SELECT = `SELECT s.*, t.label AS terminal_label FROM inbox_secrets s LEFT JOIN terminals t ON t.id = s.terminal_id`;

export class InboxSecretStore {
  readonly dir: string;

  constructor(private readonly db: Database.Database, dataDir: string) {
    this.dir = path.join(dataDir, 'inbox-secrets');
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* best effort */ }
  }

  private file(id: string): string { return path.join(this.dir, id); }

  private stateOf(r: Row, now = clock()): InboxSecretRecord['state'] {
    if (r.used_at) return 'used';
    return Date.parse(r.expires_at) <= now ? 'expired' : 'waiting';
  }

  private toRecord(r: Row): InboxSecretRecord {
    let usedTo: SecretDestination | null = null;
    try { usedTo = r.used_to ? JSON.parse(r.used_to) : null; } catch { usedTo = null; }
    return {
      id: r.id, sessionId: r.session_id, terminalId: r.terminal_id, terminalLabel: r.terminal_label ?? null, name: r.name,
      allowReveal: r.allow_reveal === 1, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at,
      usedBy: r.used_by, usedByLabel: r.used_by_label, usedTo, state: this.stateOf(r),
    };
  }

  /** Delete every value file that must go: a used or expired secret's, and one with no record. */
  sweep(): void {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    if (names.length === 0) return;
    const now = clock();
    const rows = new Map((this.db.prepare('SELECT * FROM inbox_secrets WHERE used_at IS NULL').all() as Row[]).map((r) => [r.id, r]));
    for (const n of names) {
      const r = rows.get(n);
      if (r && this.stateOf(r, now) === 'waiting') continue;
      try { fs.rmSync(this.file(n), { force: true }); } catch { /* the next read tries again */ }
    }
  }

  create(input: { name: string; value: string; sessionId: string; terminalId: string | null; allowReveal: boolean }): InboxSecretRecord {
    this.sweep();
    this.ensureDir();
    let id = newSecretId();
    for (let i = 0; this.db.prepare('SELECT 1 FROM inbox_secrets WHERE id = ?').get(id) || fs.existsSync(this.file(id)); i++) {
      if (i > 50) throw new Error('could not make a new secret ID');
      id = newSecretId();
    }
    const fd = fs.openSync(this.file(id), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeSync(fd, input.value); } finally { fs.closeSync(fd); }
    const created = clock();
    try {
      this.db.prepare(`INSERT INTO inbox_secrets (id, session_id, terminal_id, name, allow_reveal, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.sessionId, input.terminalId, input.name, input.allowReveal ? 1 : 0, new Date(created).toISOString(), new Date(created + SECRET_TTL_MS).toISOString());
    } catch (e) {
      fs.rmSync(this.file(id), { force: true });
      throw e;
    }
    return this.get(id)!;
  }

  list(filter: { sessionId?: string | null; terminalId?: string | null } = {}): InboxSecretRecord[] {
    this.sweep();
    const where: string[] = [];
    const args: string[] = [];
    if (filter.sessionId) { where.push('s.session_id = ?'); args.push(filter.sessionId); }
    if (filter.terminalId) { where.push('s.terminal_id = ?'); args.push(filter.terminalId); }
    const rows = this.db.prepare(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY s.created_at DESC`).all(...args) as Row[];
    return rows.map((r) => this.toRecord(r));
  }

  get(id: string): InboxSecretRecord | null {
    this.sweep();
    const r = this.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
    return r ? this.toRecord(r) : null;
  }

  /** The value of a waiting secret; null when it is used, expired, deleted or unknown. */
  readValue(id: string): string | null {
    const rec = this.get(id);
    if (!rec || rec.state !== 'waiting') return null;
    try {
      const fd = fs.openSync(this.file(id), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
    } catch { return null; }
  }

  /** After the one use: the value goes, the record says who used it, when, and where it went (never the value). */
  markUsed(id: string, by: { terminalId: string; label: string | null }, to: SecretDestination): void {
    fs.rmSync(this.file(id), { force: true });
    this.db.prepare('UPDATE inbox_secrets SET used_at = ?, used_by = ?, used_by_label = ?, used_to = ? WHERE id = ?')
      .run(new Date(clock()).toISOString(), by.terminalId, by.label, JSON.stringify(to), id);
  }

  remove(id: string): boolean {
    fs.rmSync(this.file(id), { force: true });
    return this.db.prepare('DELETE FROM inbox_secrets WHERE id = ?').run(id).changes > 0;
  }
}
