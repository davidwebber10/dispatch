import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import * as integrationsDb from '../db/integrations.js';
import type { Integration } from '../db/integrations.js';
import type { Creator } from '../auth/creator.js';
import type { McpServerSpec } from '../mcp/injection.js';
import { findSecretRefs, refsIn, literalSecretProblem } from './secret-refs.js';
import { launcherArgs, MCP_REMOTE_PACKAGE, type LaunchSpec } from './launcher.js';

/** Where the integration launcher lives and which Doppler connection it reads (see launcher.ts). */
export interface IntegrationLauncher { nodePath: string; launcherPath: string; secretsDir: string }

export type AddIntegrationInput =
  | { type: 'remote'; name: string; url: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { type: 'stdio'; name: string; command: string; args?: string[]; env?: Record<string, string> };

export type ExportedIntegration = Omit<Integration, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'>;
export interface IntegrationsExport { version: 1; integrations: ExportedIntegration[] }

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** What a key caller sees in place of a literal header or env value. */
export const HIDDEN_VALUE = '•••• (hidden)';
/** What stands in for the literal part around a `${NAME}` reference. */
export const HIDDEN_PART = '••••';
const REF_SPLIT = /(\$\{[A-Za-z_][A-Za-z0-9_]*\})/;
const AUTH_SCHEME = /^(Bearer|Basic|Token) $/i;

/**
 * One header or env value for a caller that is not the owner. A `${NAME}` reference is shown as it is
 * (it names a secret, it is not one). A value with no reference is hidden. A value that mixes a reference
 * with literal text keeps the reference and an auth scheme word (`Bearer `), and hides the rest.
 */
export function maskValue(value: unknown): string {
  const v = String(value ?? '');
  const parts = v.split(REF_SPLIT);
  if (parts.length === 1) return HIDDEN_VALUE;
  return parts.map((p, i) => (i % 2 === 1 || p === '' || AUTH_SCHEME.test(p) ? p : HIDDEN_PART)).join('');
}

/** Path words that are never secret. Any other path segment of a URL is hidden for a key caller. */
const SAFE_PATH_SEGMENT = /^(mcp|sse|v\d+|api|rpc|jsonrpc|http|https|ws|messages?|stream|streams|events?|server|servers|tools?|connect|public|openapi)$/i;

function maskUrl(url: string | null): string | null {
  if (!url) return url;
  try {
    const u = new URL(url);
    const params = new URLSearchParams();
    for (const k of new Set(u.searchParams.keys())) params.set(k, 'hidden');
    const path = u.pathname.split('/').map((seg) => (seg === '' || SAFE_PATH_SEGMENT.test(seg) ? seg : HIDDEN_PART)).join('/');
    const query = params.toString();
    // Built by hand: no user:password, no fragment, no percent-encoding of the hidden marker.
    return `${u.protocol}//${u.host}${path}${query ? `?${query}` : ''}`;
  } catch { return HIDDEN_VALUE; }
}

/** A flag that takes a value which can be a secret (or a header, which usually holds one). */
const SECRET_FLAG = /^--?(h|header|headers|e|env|auth|authorization|bearer|cookie|token|secret|password|passwd|pass|credential|credentials|api[-_]?key|key|access[-_]?key|client[-_]?secret)([-_].*)?$/i;
/** A command-line word that is plainly not a secret: a plain flag, a package name or version, a path, a number, a ${NAME} ref. */
const SAFE_WORD = /^[@A-Za-z0-9_][A-Za-z0-9_@.\/+~-]{0,63}$/;
const LOOKS_LIKE_TOKEN = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]{20,}$/;

/**
 * One command-line argument for a key caller, given the argument before it. A word is shown only when it is
 * plainly safe. The value of a secret-bearing flag (`--header X`, `--token X`, `--api-key=X`), a long token-like
 * word, and free text are hidden; a URL goes through the URL mask; a `${NAME}` reference shows as written.
 */
function maskArg(arg: string, prev: string | undefined): string {
  const a = String(arg ?? '');
  if (refsIn(a).length) return maskValue(a);
  const eq = /^(--?[A-Za-z][\w-]*)=/.exec(a);
  if (eq) return `${eq[1]}=${HIDDEN_PART}`;
  if (/^-/.test(a)) return /^--?[A-Za-z][\w-]*$/.test(a) ? a : HIDDEN_VALUE; // a plain flag shows; a negative number or odd text does not leak either
  if (prev !== undefined && /^-/.test(prev) && SECRET_FLAG.test(prev)) return HIDDEN_VALUE;
  if (/^https?:\/\//i.test(a)) return maskUrl(a) ?? HIDDEN_VALUE;
  if (SAFE_WORD.test(a) && !LOOKS_LIKE_TOKEN.test(a)) return a;
  return HIDDEN_VALUE;
}

function maskCommand(command: string | null): string | null {
  if (!command) return command;
  return /[\s=]/.test(command) ? HIDDEN_VALUE : command; // an inline shell line can hold a secret; a program path cannot
}

/** An integration as a thread key may read it: header and env values masked, args and command stripped of secrets, the url cut to its safe parts. */
export function maskIntegration(i: Integration): Integration {
  const mask = (bag: Record<string, string>) => Object.fromEntries(Object.entries(bag).map(([k, v]) => [k, maskValue(v)]));
  return { ...i, command: maskCommand(i.command), args: i.args.map((a, n) => maskArg(a, i.args[n - 1])), url: maskUrl(i.url), headers: mask(i.headers), env: mask(i.env) };
}

export class IntegrationsService {
  /**
   * `refsAvailable`: true when a `${NAME}` reference can resolve (Doppler is connected). Without it a typed-in value is the only
   * way to give a server its key, so it is allowed (SEC-17 refuses a literal only where a reference can be used instead).
   */
  constructor(private db: Database.Database, private launcher: IntegrationLauncher | null = null, private refsAvailable: () => boolean = () => true) {}

  /** Returns an error string if the input is invalid, else null. */
  static validate(input: any): string | null {
    if (!input || typeof input !== 'object') return 'body required';
    if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) return 'name must match ^[a-zA-Z0-9_-]+$ (no spaces)';
    if (input.type === 'remote') {
      if (typeof input.url !== 'string' || !/^https?:\/\//.test(input.url)) return 'remote requires an http(s) url';
      return null;
    }
    if (input.type === 'stdio') {
      if (typeof input.command !== 'string' || !input.command.trim()) return 'stdio requires a command';
      return null;
    }
    return `unknown integration type: ${String(input.type)}`;
  }

  /** The static checks, then the SEC-17 check: no typed-in secret where a `${NAME}` reference can be used. */
  validateInput(input: any): string | null {
    const err = IntegrationsService.validate(input);
    if (err) return err;
    if (!this.refsAvailable()) return null;
    return literalSecretProblem(input.type === 'remote' ? input : { env: input.env });
  }

  list(): Integration[] { return integrationsDb.list(this.db); }

  add(input: AddIntegrationInput, createdBy?: Creator | null): Integration {
    const err = this.validateInput(input);
    if (err) throw new Error(err);
    if (this.list().some((i) => i.name.toLowerCase() === input.name.toLowerCase())) {
      throw new Error(`an integration named "${input.name}" already exists`);
    }
    return integrationsDb.create(this.db, {
      id: uuid(), name: input.name, type: input.type,
      command: input.type === 'stdio' ? input.command : null,
      args: input.type === 'stdio' ? (input.args ?? []) : [],
      url: input.type === 'remote' ? input.url : null,
      headers: input.type === 'remote' ? (input.headers ?? {}) : {},
      env: input.env ?? {},
      createdBy: createdBy ?? null,
    });
  }

  remove(id: string): { removed: boolean } { integrationsDb.remove(this.db, id); return { removed: true }; }

  setEnabled(id: string, enabled: boolean): Integration | null { return integrationsDb.setEnabled(this.db, id, enabled); }

  /**
   * Resolve every enabled integration to an McpServerSpec for composeInjection. One with
   * `${NAME}` refs in a header or env value runs through the launcher (when configured),
   * which resolves them from Doppler inside the server's own process. Env entries with a
   * ref go to the launcher as templates, never as spec `env`, since each harness treats
   * `${...}` in env differently; literal env entries keep today's spec `env` path.
   */
  getServerSpecs(): McpServerSpec[] {
    const specs: McpServerSpec[] = [];
    try {
      for (const i of this.list()) {
        if (!i.enabled) continue;
        try {
          if (i.type === 'stdio') {
            if (!i.command) continue;
            specs.push(this.launched(i) ?? { name: i.name, command: i.command, args: i.args, ...(Object.keys(i.env).length ? { env: i.env } : {}) });
          } else {
            if (!i.url) continue;
            const headerArgs = Object.entries(i.headers).flatMap(([k, v]) => ['--header', `${k}:${v}`]);
            specs.push(this.launched(i) ?? { name: i.name, command: 'npx', args: ['-y', MCP_REMOTE_PACKAGE, i.url, ...headerArgs], ...(Object.keys(i.env).length ? { env: i.env } : {}) });
          }
        } catch { /* skip a malformed row rather than break a spawn */ }
      }
    } catch { /* DB-level failure — return whatever we collected; never break a spawn */ }
    return specs;
  }

  /**
   * The launcher spec for an integration with secret refs; null (plain spec) without refs or a launcher.
   * Only env entries WITH a ref ride the --spec (argv). Literal entries stay on the spec's `env`, the
   * same path a plain spec uses, and reach the server by inheritance through the launcher.
   */
  private launched(i: Integration): McpServerSpec | null {
    if (!this.launcher || !findSecretRefs(i).length) return null;
    const refEnv: Record<string, string> = {};
    const literalEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(i.env)) (refsIn(String(v)).length ? refEnv : literalEnv)[k] = v;
    const tpl: LaunchSpec = i.type === 'stdio'
      ? { name: i.name, type: 'stdio', command: i.command, args: i.args, env: refEnv }
      : { name: i.name, type: 'remote', url: i.url, headers: i.headers, env: refEnv };
    return {
      name: i.name, command: this.launcher.nodePath, args: launcherArgs(this.launcher.launcherPath, this.launcher.secretsDir, tpl),
      ...(Object.keys(literalEnv).length ? { env: literalEnv } : {}),
    };
  }

  export(): IntegrationsExport {
    return { version: 1, integrations: this.list().map(({ id, createdAt, updatedAt, createdBy: _by, ...rest }) => rest) };
  }

  import(doc: IntegrationsExport, createdBy?: Creator | null): { added: string[]; skipped: string[]; reasons: { name: string; reason: string }[] } {
    const added: string[] = []; const skipped: string[] = []; const reasons: { name: string; reason: string }[] = [];
    const existing = new Set(this.list().map((i) => i.name.toLowerCase()));
    for (const e of doc?.integrations ?? []) {
      if (!e || typeof e.name !== 'string' || existing.has(e.name.toLowerCase())) { if (e?.name) skipped.push(e.name); continue; }
      const input: AddIntegrationInput = e.type === 'stdio'
        ? { type: 'stdio', name: e.name, command: e.command ?? '', args: e.args, env: e.env }
        : { type: 'remote', name: e.name, url: e.url ?? '', headers: e.headers, env: e.env };
      const problem = this.validateInput(input);
      if (problem) { skipped.push(e.name); reasons.push({ name: e.name, reason: problem }); continue; }
      this.add(input, createdBy); existing.add(e.name.toLowerCase()); added.push(e.name);
    }
    return { added, skipped, reasons };
  }
}
