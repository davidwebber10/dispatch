import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import * as integrationsDb from '../db/integrations.js';
import type { Integration } from '../db/integrations.js';
import type { McpServerSpec } from '../mcp/injection.js';

export type AddIntegrationInput =
  | { type: 'remote'; name: string; url: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { type: 'stdio'; name: string; command: string; args?: string[]; env?: Record<string, string> };

export type ExportedIntegration = Omit<Integration, 'id' | 'createdAt' | 'updatedAt'>;
export interface IntegrationsExport { version: 1; integrations: ExportedIntegration[] }

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export class IntegrationsService {
  constructor(private db: Database.Database) {}

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

  list(): Integration[] { return integrationsDb.list(this.db); }

  add(input: AddIntegrationInput): Integration {
    const err = IntegrationsService.validate(input);
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
    });
  }

  remove(id: string): { removed: boolean } { integrationsDb.remove(this.db, id); return { removed: true }; }

  setEnabled(id: string, enabled: boolean): Integration | null { return integrationsDb.setEnabled(this.db, id, enabled); }

  /** Resolve every enabled integration to an McpServerSpec for composeInjection. */
  getServerSpecs(): McpServerSpec[] {
    const specs: McpServerSpec[] = [];
    try {
      for (const i of this.list()) {
        if (!i.enabled) continue;
        try {
          if (i.type === 'stdio') {
            if (!i.command) continue;
            specs.push({ name: i.name, command: i.command, args: i.args, ...(Object.keys(i.env).length ? { env: i.env } : {}) });
          } else {
            if (!i.url) continue;
            const headerArgs = Object.entries(i.headers).flatMap(([k, v]) => ['--header', `${k}:${v}`]);
            specs.push({ name: i.name, command: 'npx', args: ['-y', 'mcp-remote', i.url, ...headerArgs], ...(Object.keys(i.env).length ? { env: i.env } : {}) });
          }
        } catch { /* skip a malformed row rather than break a spawn */ }
      }
    } catch { /* DB-level failure — return whatever we collected; never break a spawn */ }
    return specs;
  }

  export(): IntegrationsExport {
    return { version: 1, integrations: this.list().map(({ id, createdAt, updatedAt, ...rest }) => rest) };
  }

  import(doc: IntegrationsExport): { added: string[]; skipped: string[] } {
    const added: string[] = []; const skipped: string[] = [];
    const existing = new Set(this.list().map((i) => i.name.toLowerCase()));
    for (const e of doc?.integrations ?? []) {
      if (!e || typeof e.name !== 'string' || existing.has(e.name.toLowerCase())) { if (e?.name) skipped.push(e.name); continue; }
      const input: AddIntegrationInput = e.type === 'stdio'
        ? { type: 'stdio', name: e.name, command: e.command ?? '', args: e.args, env: e.env }
        : { type: 'remote', name: e.name, url: e.url ?? '', headers: e.headers, env: e.env };
      if (IntegrationsService.validate(input)) { skipped.push(e.name); continue; }
      this.add(input); existing.add(e.name.toLowerCase()); added.push(e.name);
    }
    return { added, skipped };
  }
}
