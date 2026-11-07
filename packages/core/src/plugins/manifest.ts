import path from 'node:path';

/**
 * Plugins (docs/superpowers/specs/2026-11-07-plugins-design.md, section 1): the manifest a
 * plugin folder carries as `plugin.json`, and the checks that decide whether a folder is a
 * plugin Dispatch will load or a broken one the Plugins page shows with its reason.
 */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PluginContributes {
  views?: { id: string; label: string; icon?: string }[];
  settings?: { id: string; label: string }[];
  menus?: { thread?: string[]; project?: string[] };
  slots?: string[];
  tools?: string[];
}

export type HookEvent = 'prompt' | 'turnEnd' | 'toolCall' | 'spawn' | 'status';
export interface PluginHookSpec { run: string; tools?: string[] }
/** The model part (spec section 3): instructions text, an MCP server, hook scripts, and which harnesses get them. */
export interface PluginModel {
  instructions?: string;
  mcp?: { command: string; args?: string[]; env?: Record<string, string> };
  hooks?: Partial<Record<HookEvent, PluginHookSpec>>;
  harnesses?: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** A `>=X.Y[.Z]` range the running daemon must satisfy. */
  dispatch?: string;
  /** The SDK major the web part was built against. */
  sdk?: number;
  /** The browser bundle, relative to the plugin folder. */
  web?: string;
  /** A bundled plugin starts enabled only when it says so (a new model call per prompt is opt-in); local plugins always start enabled. */
  enabledByDefault?: boolean;
  contributes?: PluginContributes;
  permissions?: string[];
  model?: PluginModel;
}

export type ParsedManifest = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** True when `rel` names a file inside the folder: no absolute path, no `..` escape. */
function insideFolder(rel: string): boolean {
  if (!rel || path.posix.isAbsolute(rel) || path.isAbsolute(rel)) return false;
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  return norm !== '..' && !norm.startsWith('../') && norm !== '.' && !norm.endsWith('/');
}

export function parseManifest(raw: string, folderId: string): ParsedManifest {
  let data: unknown;
  try { data = JSON.parse(raw); } catch (e) { return { ok: false, error: `plugin.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!isRecord(data)) return { ok: false, error: 'plugin.json must be an object' };
  if (data.id !== folderId) return { ok: false, error: `plugin.json id "${String(data.id)}" does not match the folder "${folderId}"` };
  if (!nonEmpty(data.name)) return { ok: false, error: 'plugin.json needs a name' };
  if (!nonEmpty(data.version)) return { ok: false, error: 'plugin.json needs a version' };
  if (data.web !== undefined && (typeof data.web !== 'string' || !insideFolder(data.web))) {
    return { ok: false, error: 'plugin.json "web" must be a file inside the plugin folder' };
  }
  const m: PluginManifest = { id: folderId, name: data.name.trim(), version: data.version.trim() };
  if (typeof data.description === 'string') m.description = data.description;
  if (typeof data.author === 'string') m.author = data.author;
  if (typeof data.dispatch === 'string') m.dispatch = data.dispatch;
  if (typeof data.sdk === 'number') m.sdk = data.sdk;
  if (typeof data.web === 'string') m.web = data.web;
  if (data.enabledByDefault === true) m.enabledByDefault = true;
  if (isRecord(data.contributes)) m.contributes = data.contributes as PluginContributes;
  if (Array.isArray(data.permissions)) m.permissions = data.permissions.filter((p): p is string => typeof p === 'string');
  if (data.model !== undefined) {
    const model = parseModel(data.model);
    if (!model.ok) return model;
    m.model = model.model;
  }
  return { ok: true, manifest: m };
}

/** `>=X.Y` or `>=X.Y.Z` against the running version; no range means any version; anything else is refused. */
export function satisfiesDispatch(range: string | undefined, running: string): boolean {
  if (range === undefined) return true;
  const m = /^\s*>=\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/.exec(range);
  if (!m) return false;
  const want = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  const have = running.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0; const b = want[i];
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

const HOOK_EVENTS: HookEvent[] = ['prompt', 'turnEnd', 'toolCall', 'spawn', 'status'];

function parseModel(raw: unknown): { ok: true; model: PluginModel } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'plugin.json "model" must be an object' };
  const model: PluginModel = {};
  if (raw.instructions !== undefined) {
    if (typeof raw.instructions !== 'string' || !insideFolder(raw.instructions)) return { ok: false, error: 'plugin.json "model.instructions" must be a file inside the plugin folder' };
    model.instructions = raw.instructions;
  }
  if (raw.mcp !== undefined) {
    if (!isRecord(raw.mcp) || !nonEmpty(raw.mcp.command)) return { ok: false, error: 'plugin.json "model.mcp" needs a command' };
    const args = Array.isArray(raw.mcp.args) ? raw.mcp.args.filter((a): a is string => typeof a === 'string') : [];
    const env: Record<string, string> = {};
    if (isRecord(raw.mcp.env)) for (const [k, v] of Object.entries(raw.mcp.env)) if (typeof v === 'string') env[k] = v;
    model.mcp = { command: raw.mcp.command.trim(), args, env };
  }
  if (raw.hooks !== undefined) {
    if (!isRecord(raw.hooks)) return { ok: false, error: 'plugin.json "model.hooks" must be an object' };
    const hooks: Partial<Record<HookEvent, PluginHookSpec>> = {};
    for (const [event, spec] of Object.entries(raw.hooks)) {
      if (!HOOK_EVENTS.includes(event as HookEvent)) return { ok: false, error: `plugin.json "model.hooks" has an unknown event "${event}" (prompt, turnEnd, toolCall, spawn, status)` };
      if (!isRecord(spec) || typeof spec.run !== 'string' || !insideFolder(spec.run)) return { ok: false, error: `plugin.json "model.hooks.${event}.run" must be a file inside the plugin folder` };
      hooks[event as HookEvent] = { run: spec.run, ...(Array.isArray(spec.tools) ? { tools: spec.tools.filter((t): t is string => typeof t === 'string') } : {}) };
    }
    model.hooks = hooks;
  }
  if (raw.harnesses !== undefined) {
    if (!Array.isArray(raw.harnesses)) return { ok: false, error: 'plugin.json "model.harnesses" must be a list' };
    model.harnesses = raw.harnesses.filter((h): h is string => typeof h === 'string');
  }
  return { ok: true, model };
}
