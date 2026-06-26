import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerSpec } from '../mcp/injection.js';

const execFileP = promisify(execFile);

export interface Integration {
  slug: string;
  description: string;
  kind: string;
  canRemove: boolean;
  canRefresh: boolean;
}

export type AddIntegrationInput =
  | { type: 'openapi'; url: string; slug: string }
  | { type: 'mcp-stdio'; name: string; command: string; args: string[]; slug?: string }
  | { type: 'mcp-remote'; name: string; endpoint: string; slug?: string }
  | { type: 'graphql'; endpoint: string; slug: string };

export interface AddIntegrationResult { slug: string; toolCount?: number }

/** Injectable IO so list/add/remove are unit-testable without a real executor daemon. */
export interface IntegrationsDeps {
  /** Run `executor <args>` and return stdout. */
  run: (args: string[]) => Promise<string>;
  /** DELETE the catalog entry via the daemon's HTTP API (token read server-side). */
  deleteCatalogEntry: (slug: string) => Promise<{ removed: boolean }>;
}

// --- default deps (real IO) ---------------------------------------------------

async function defaultRun(args: string[]): Promise<string> {
  // 30s timeout covers daemon cold-start (~1s) plus remote spec fetches.
  const { stdout } = await execFileP('executor', args, { encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

async function defaultDeleteCatalogEntry(slug: string): Promise<{ removed: boolean }> {
  const authPath = path.join(os.homedir(), '.executor', 'server-control', 'auth.json');
  const token = JSON.parse(fs.readFileSync(authPath, 'utf-8')).token as string;
  const res = await fetch(`http://localhost:4788/api/integrations/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`executor DELETE failed: ${res.status}`);
  return (await res.json()) as { removed: boolean };
}

export class IntegrationsService {
  // Detection result is cached for the daemon's lifetime: installing `executor`
  // after startup is not reflected until the daemon is restarted.
  private detected: { installed: boolean; version: string | null } | null = null;
  private readonly deps: IntegrationsDeps;

  constructor(deps?: Partial<IntegrationsDeps>) {
    this.deps = { run: defaultRun, deleteCatalogEntry: defaultDeleteCatalogEntry, ...deps };
  }

  status(): { installed: boolean; version: string | null } {
    if (this.detected) return this.detected;
    try {
      const v = execFileSync('executor', ['--version'], { encoding: 'utf-8', timeout: 4000 }).trim();
      this.detected = { installed: true, version: v };
    } catch { this.detected = { installed: false, version: null }; }
    return this.detected;
  }

  getServerSpec(): McpServerSpec | null {
    if (!this.status().installed) return null;
    return { name: 'executor', command: 'executor', args: ['mcp', '--elicitation-mode', 'model'] };
  }

  getSystemPrompt(): string | null {
    if (!this.status().installed) return null;
    return 'An "executor" MCP server exposes your shared integration catalog (the same tools across Claude and Codex). Use its tools to call integrations, and its management tools to add a new integration when given API docs, a CLI, or an MCP. If Doppler is connected, store any credentials there.';
  }

  /** List integrations from the executor catalog. */
  async list(): Promise<Integration[]> {
    const data = await this.callJson(['call', 'executor', 'coreTools', 'integrations', 'list']);
    const arr: any[] = Array.isArray(data?.integrations) ? data.integrations : [];
    return arr.map((i) => ({
      slug: String(i.slug),
      description: typeof i.description === 'string' ? i.description : '',
      kind: typeof i.kind === 'string' ? i.kind : 'unknown',
      canRemove: !!i.canRemove,
      canRefresh: !!i.canRefresh,
    }));
  }

  /** Add a source to the catalog, then best-effort materialize its tools. */
  async add(input: AddIntegrationInput): Promise<AddIntegrationResult> {
    let slug: string;
    let toolCount: number | undefined;
    if (input.type === 'openapi') {
      const d = await this.callJson(['call', 'executor', 'openapi', 'addSpec',
        JSON.stringify({ spec: { kind: 'url', url: input.url }, slug: input.slug })]);
      slug = d.slug; toolCount = typeof d.toolCount === 'number' ? d.toolCount : undefined;
    } else if (input.type === 'mcp-stdio') {
      const d = await this.callJson(['call', 'executor', 'mcp', 'addServer',
        JSON.stringify({ transport: 'stdio', name: input.name, command: input.command, args: input.args, ...(input.slug ? { slug: input.slug } : {}) })]);
      slug = d.slug;
    } else if (input.type === 'mcp-remote') {
      const d = await this.callJson(['call', 'executor', 'mcp', 'addServer',
        JSON.stringify({ transport: 'remote', name: input.name, endpoint: input.endpoint, ...(input.slug ? { slug: input.slug } : {}) })]);
      slug = d.slug;
    } else {
      const d = await this.callJson(['call', 'executor', 'graphql', 'addIntegration',
        JSON.stringify({ endpoint: input.endpoint, slug: input.slug })]);
      slug = d.slug;
    }
    // Materialize tools for no-auth sources; non-fatal (catalog entry exists regardless).
    try {
      await this.callJson(['call', 'executor', 'coreTools', 'connections', 'create',
        JSON.stringify({ owner: 'org', name: 'default', integration: slug, template: 'none' })]);
    } catch { /* best-effort: auth'd sources get credentials via executor's own UI */ }
    return { slug, toolCount };
  }

  /** Remove a source: drop its connection (best-effort) then delete the catalog entry. */
  async remove(slug: string): Promise<{ removed: boolean }> {
    try {
      await this.callJson(['call', 'executor', 'coreTools', 'connections', 'remove',
        JSON.stringify({ owner: 'org', name: 'default', integration: slug })]);
    } catch { /* no connection / already gone — the connection call also auto-starts the daemon */ }
    return this.deps.deleteCatalogEntry(slug);
  }

  /** Run an `executor call` and unwrap its {ok,data} envelope. */
  private async callJson(args: string[]): Promise<any> {
    const stdout = await this.deps.run(args);
    let parsed: any;
    try { parsed = JSON.parse(stdout); }
    catch { throw new Error(`executor: unparseable output: ${stdout.slice(0, 200)}`); }
    if (parsed && parsed.ok === false) throw new Error(typeof parsed.error === 'string' ? parsed.error : 'executor call failed');
    return parsed && 'data' in parsed ? parsed.data : parsed;
  }
}
