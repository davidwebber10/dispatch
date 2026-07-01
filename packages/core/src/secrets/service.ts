import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DopplerClient, type DopplerProject, type DopplerConfig, type DopplerSecret } from './doppler.js';
import { composeInjection, type McpServerSpec } from '../mcp/injection.js';

export interface DopplerStatus {
  connected: boolean;
  project: string | null;
  config: string | null;
  enabled: boolean;
  readOnly: boolean;
}

export interface SetConnectionInput {
  token?: string;
  project?: string;
  config?: string;
  enabled?: boolean;
  readOnly?: boolean;
}

interface StoredConnection {
  token: string | null;
  project: string | null;
  config: string | null;
  enabled: boolean;
  readOnly: boolean;
}

// From packages/core/{src,dist}/secrets/service.* up to packages/, then into the sibling package.
const DEFAULT_MCP_REL = '../../../doppler-mcp/dist/index.js';

function resolveDefaultMcpPath(): string {
  if (process.env.DISPATCH_DOPPLER_MCP) return process.env.DISPATCH_DOPPLER_MCP;
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), DEFAULT_MCP_REL);
  } catch {
    return '';
  }
}

/**
 * Owns the Doppler connection for a host: the bootstrap token (a 0600 file, never
 * returned to clients), the project/config/enabled/readOnly settings, the Doppler
 * API proxy used by the Settings UI, and the spawn-time injection (env + MCP config)
 * that lets Claude Code / Codex agents add & retrieve secrets.
 */
export class SecretsService {
  private readonly filePath: string;
  private readonly mcpConfigPath: string;
  private onChangeCb: (() => void) | null = null;

  constructor(
    private readonly configDir: string,
    private readonly clientFactory: (token: string) => DopplerClient = (t) => new DopplerClient(t),
    private readonly dopplerMcpPath: string = resolveDefaultMcpPath(),
  ) {
    this.filePath = path.join(configDir, 'doppler.json');
    this.mcpConfigPath = path.join(configDir, 'doppler.mcp.json');
  }

  onChange(cb: () => void): void { this.onChangeCb = cb; }

  // --- persistence -------------------------------------------------------
  private read(): StoredConnection {
    let stored: Partial<StoredConnection> = {};
    try { stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch { /* none yet */ }
    const token = (typeof stored.token === 'string' && stored.token) ? stored.token : (process.env.DOPPLER_TOKEN || null);
    return {
      token,
      project: stored.project ?? null,
      config: stored.config ?? null,
      enabled: stored.enabled !== false,
      readOnly: stored.readOnly === true,
    };
  }

  private write(c: StoredConnection): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(c, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* best effort on FS that lacks chmod */ }
  }

  // --- status / connection ----------------------------------------------
  status(): DopplerStatus {
    const c = this.read();
    return {
      connected: !!c.token && !!c.project && !!c.config,
      project: c.project,
      config: c.config,
      enabled: c.enabled,
      readOnly: c.readOnly,
    };
  }

  /**
   * Upsert the connection. A non-empty `token` is verified against Doppler before
   * saving; an empty/omitted token preserves the stored one (so the read-only toggle
   * and project/config changes don't require re-entering the token).
   */
  async setConnection(input: SetConnectionInput): Promise<DopplerStatus> {
    const cur = this.read();
    let token = cur.token;
    if (typeof input.token === 'string' && input.token.trim()) {
      const candidate = input.token.trim();
      if (!(await this.clientFactory(candidate).verify())) throw new Error('Invalid Doppler token');
      token = candidate;
    }
    this.write({
      token,
      project: input.project !== undefined ? (input.project || null) : cur.project,
      config: input.config !== undefined ? (input.config || null) : cur.config,
      enabled: input.enabled !== undefined ? !!input.enabled : cur.enabled,
      readOnly: input.readOnly !== undefined ? !!input.readOnly : cur.readOnly,
    });
    this.refresh();
    return this.status();
  }

  disconnect(): DopplerStatus {
    try { fs.rmSync(this.filePath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(this.mcpConfigPath, { force: true }); } catch { /* ignore */ }
    this.refresh();
    return this.status();
  }

  // --- Doppler proxy (Settings UI) --------------------------------------
  private requireClient(): DopplerClient {
    const token = this.read().token;
    if (!token) throw new Error('Doppler is not connected');
    return this.clientFactory(token);
  }

  // These are `async` so guard violations surface as rejected promises (not sync throws).
  async listProjects(): Promise<DopplerProject[]> { return this.requireClient().listProjects(); }
  async listConfigs(project: string): Promise<DopplerConfig[]> {
    if (!project) throw new Error('project is required');
    return this.requireClient().listConfigs(project);
  }
  async listSecrets(project?: string, config?: string): Promise<DopplerSecret[]> {
    const c = this.read();
    const p = project || c.project, cf = config || c.config;
    if (!p || !cf) throw new Error('project and config are required');
    return this.requireClient().listSecrets(p, cf);
  }

  /** Resolve a single secret's value by name (server-side only; never returned to clients). */
  async getSecret(name: string): Promise<string | null> {
    const c = this.read();
    if (!c.token || !c.project || !c.config) throw new Error('Doppler is not connected');
    return this.clientFactory(c.token).getSecret(c.project, c.config, name);
  }

  async setSecret(name: string, value: string): Promise<void> {
    const c = this.read();
    if (!c.project || !c.config) throw new Error('project and config are required');
    if (c.readOnly) throw new Error('secrets are read-only');
    return this.requireClient().setSecret(c.project, c.config, name, value);
  }
  async deleteSecret(name: string): Promise<void> {
    const c = this.read();
    if (!c.project || !c.config) throw new Error('project and config are required');
    if (c.readOnly) throw new Error('secrets are read-only');
    return this.requireClient().deleteSecret(c.project, c.config, name);
  }

  // --- spawn-time injection for Claude/Codex ----------------------------
  /** Env injected into spawned CLIs (resolves ${DOPPLER_*} refs in the MCP config). */
  getSpawnEnv(): Record<string, string> {
    const c = this.read();
    if (!c.token || !c.project || !c.config || !c.enabled) return {};
    return {
      DOPPLER_TOKEN: c.token,
      DOPPLER_PROJECT: c.project,
      DOPPLER_CONFIG: c.config,
      DOPPLER_READ_ONLY: c.readOnly ? '1' : '0',
    };
  }

  private active(): boolean {
    const c = this.read();
    return !!c.token && !!c.project && !!c.config && c.enabled
      && !!this.dopplerMcpPath && fs.existsSync(this.dopplerMcpPath);
  }

  /** Write (and return the path to) the Claude `--mcp-config` file; token by reference. */
  ensureClaudeMcpConfig(): string | null {
    if (!this.active()) return null;
    const cfg = {
      mcpServers: {
        doppler: {
          command: 'node',
          args: [this.dopplerMcpPath],
          env: {
            DOPPLER_TOKEN: '${DOPPLER_TOKEN}',
            DOPPLER_PROJECT: '${DOPPLER_PROJECT}',
            DOPPLER_CONFIG: '${DOPPLER_CONFIG}',
            DOPPLER_READ_ONLY: '${DOPPLER_READ_ONLY}',
          },
        },
      },
    };
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify(cfg, null, 2));
    return this.mcpConfigPath;
  }

  /**
   * Standing instruction appended to a spawned agent's system prompt so it knows
   * to keep secrets in Doppler (via the MCP tools) rather than hardcoding them.
   * Null unless Doppler is active, so agents are never told to use a server that
   * isn't wired in.
   */
  getSystemPrompt(): string | null {
    if (!this.active()) return null;
    const c = this.read();
    const base =
      `This workspace uses Doppler for secrets management (project "${c.project}", config "${c.config}"). ` +
      `A "doppler" MCP server is available to you. When you need an API key, token, password, or other secret, ` +
      `retrieve it with the Doppler MCP tools (e.g. doppler_get_secret, doppler_list_secrets) and store new secrets ` +
      `with doppler_set_secret. Never hardcode secrets, write them to .env files, or commit them to the repo.`;
    return c.readOnly
      ? `${base} Secrets are read-only here: retrieve them but do not create, modify, or delete.`
      : base;
  }

  getServerSpec(): McpServerSpec | null {
    if (!this.active()) return null;
    return {
      name: 'doppler', command: 'node', args: [this.dopplerMcpPath],
      env: { DOPPLER_TOKEN: '${DOPPLER_TOKEN}', DOPPLER_PROJECT: '${DOPPLER_PROJECT}', DOPPLER_CONFIG: '${DOPPLER_CONFIG}', DOPPLER_READ_ONLY: '${DOPPLER_READ_ONLY}' },
      envVars: ['DOPPLER_TOKEN', 'DOPPLER_PROJECT', 'DOPPLER_CONFIG', 'DOPPLER_READ_ONLY'],
    };
  }

  getInjection(): { claudeConfigPath: string | null; codexArgs: string[]; systemPrompt: string | null } {
    const spec = this.getServerSpec();
    return composeInjection(spec ? [spec] : [], { configPath: this.mcpConfigPath, prompts: [this.getSystemPrompt() ?? ''] });
  }

  private refresh(): void {
    try { this.ensureClaudeMcpConfig(); } catch { /* ignore */ }
    this.onChangeCb?.();
  }
}
