// packages/core/src/os/company-model.ts
// Company models for Claude Code (capability `company-claude-v1`, docs/hosted.md "Company models").
//
// The platform may grant a person a COMPANY model: the platform holds the model credential and runs a
// metered proxy. The broker answer (GET /api/dispatch/connections, integrations/os-provider.ts) then
// carries two optional fields:
//
//   modelAccess  which models the person may use, through which harness, and whether their own
//                subscription login is allowed;
//   modelProxy   where the proxy is (`anthropicBaseUrl` for Claude Code).
//
// Absent `modelAccess`: nothing here changes a thread. Present: a Claude Code thread on a granted company
// Claude model runs with `config.modelSource: "company"`, and its Anthropic traffic goes to the daemon's
// loopback relay (os/model-relay.ts), which forwards it to the platform with the box token. The thread
// never holds the box token or the model credential: it holds only its own per-thread key.
//
// This module holds the pure decisions (which threads are company threads, the env of such a thread)
// and the one live source the routes and the spawner read (`setCompanyModelSource`), like os/profile.ts.

/** What the platform says the person may use (`modelAccess` of the broker answer). */
export interface ModelAccess {
  models: string[];
  default: string | null;
  subscriptionsAllowed: boolean | null;
  subscriptions: { claude: boolean | null; codex: boolean | null };
  harnesses: string[];
  seatFirst: boolean;
  /** Model id -> harness id. Null when the platform sent none. */
  modelHarness: Record<string, string> | null;
}

/** Where the platform's model proxy is (`modelProxy` of the broker answer). */
export interface ModelProxy {
  openaiBaseUrl: string | null;
  anthropicBaseUrl: string | null;
  usageUrl: string | null;
}

export type ModelSource = 'company' | 'subscription';

/** The plain sentence of a refused company model. */
export const MODEL_NOT_AVAILABLE = 'This model is not available to you.';
/** The plain sentence of a refused personal login. */
export const SUBSCRIPTION_NOT_ALLOWED = 'Your own Claude login is turned off for you. Use the company model.';
/** A company thread keeps its model. */
export const COMPANY_MODEL_FIXED = 'A thread on a company model keeps its model. Start a new thread to use another model.';
/** A thread on the person's own login cannot move to the company model while it runs. */
export const START_NEW_FOR_COMPANY = 'Start a new thread to use the company model.';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => x !== null) : []);

function httpUrl(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s.replace(/\/+$/, '') : null;
  } catch { return null; }
}

/** `modelAccess` in the contract shape. Null when it is absent or not an object (then nothing changes). */
export function parseModelAccess(raw: unknown): ModelAccess | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const subs = o.subscriptions && typeof o.subscriptions === 'object' ? o.subscriptions as Record<string, unknown> : {};
  let modelHarness: Record<string, string> | null = null;
  if (o.modelHarness && typeof o.modelHarness === 'object' && !Array.isArray(o.modelHarness)) {
    modelHarness = {};
    for (const [k, v] of Object.entries(o.modelHarness as Record<string, unknown>)) {
      const h = str(v);
      if (str(k) && h) modelHarness[k.trim()] = h;
    }
  }
  return {
    models: strList(o.models),
    default: str(o.default),
    subscriptionsAllowed: bool(o.subscriptionsAllowed),
    subscriptions: { claude: bool(subs.claude), codex: bool(subs.codex) },
    harnesses: strList(o.harnesses),
    seatFirst: o.seatFirst === true,
    modelHarness,
  };
}

/** `modelProxy` in the contract shape. Null when it is absent, null, or names no usable address. */
export function parseModelProxy(raw: unknown): ModelProxy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const p = { openaiBaseUrl: httpUrl(o.openaiBaseUrl), anthropicBaseUrl: httpUrl(o.anthropicBaseUrl), usageUrl: httpUrl(o.usageUrl) };
  return p.openaiBaseUrl || p.anthropicBaseUrl || p.usageUrl ? p : null;
}

/** The harness the platform names for a model: `modelHarness`, else `claude-code` for an id that starts with `claude-`. */
export function harnessOfModel(access: ModelAccess, id: string): string | null {
  if (access.modelHarness) return access.modelHarness[id] ?? null;
  return id.startsWith('claude-') ? 'claude-code' : null;
}

/** Every model id the platform names (granted or not). */
function knownIds(access: ModelAccess): string[] {
  return [...new Set([...access.models, ...Object.keys(access.modelHarness ?? {})])];
}

/**
 * The platform's id for a model a thread names: the id itself, any case, or the id without its
 * `claude-` prefix (`opus-5-5`). Null when the platform does not name the model.
 */
export function companyModelId(access: ModelAccess, model: string | null | undefined): string | null {
  const m = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!m) return null;
  for (const id of knownIds(access)) {
    const low = id.toLowerCase();
    if (low === m || (low.startsWith('claude-') && low.slice('claude-'.length) === m)) return id;
  }
  return null;
}

/** True when the platform grants this id NOW as a Claude Code model. */
export function isGrantedCompanyClaude(access: ModelAccess | null, id: string | null | undefined): boolean {
  if (!access || !id) return false;
  return access.models.includes(id) && harnessOfModel(access, id) === 'claude-code';
}

/** The company Claude model a thread gets when it names none: `default` when it is one, else the first granted. */
export function defaultCompanyClaude(access: ModelAccess): string | null {
  if (access.default && isGrantedCompanyClaude(access, access.default)) return access.default;
  return access.models.find((m) => isGrantedCompanyClaude(access, m)) ?? null;
}

/** Whether the platform allows the person's own Claude login: `subscriptions.claude`, else `subscriptionsAllowed`, else yes. */
export function claudeSubscriptionAllowed(access: ModelAccess): boolean {
  return access.subscriptions.claude ?? access.subscriptionsAllowed ?? true;
}

export type ModelDecision =
  | { ok: true; patch: { model?: string; modelSource?: ModelSource } | null; strip?: boolean }
  | { ok: false; status: 403; message: string };

/**
 * Which source a NEW Claude Code thread runs on. `personalSignedIn`: the person has a Claude login the
 * thread could use. The rules (docs/hosted.md "Company models"):
 *  - no `modelAccess`: today's behaviour (`modelSource: "company"` is refused, any other is dropped);
 *  - `modelSource: "subscription"`: the person's own login (refused when the platform turned it off);
 *  - a granted company Claude model: the company model when asked for, or when there is no usable
 *    personal login; with `seatFirst` and a usable personal login, the personal login;
 *  - a model the platform names but does not grant: refused when it would run on the company model;
 *  - no model: with no usable personal login (or `modelSource: "company"`), the company default model.
 * `patch` is what to merge into the thread's config; `strip` drops a `modelSource` that means nothing.
 */
export function decideClaudeSource(access: ModelAccess | null, config: Record<string, unknown>, personalSignedIn: boolean): ModelDecision {
  const asked = config.modelSource === 'company' || config.modelSource === 'subscription' ? config.modelSource : null;
  if (!access) {
    if (asked === 'company') return { ok: false, status: 403, message: MODEL_NOT_AVAILABLE };
    return { ok: true, patch: null, strip: config.modelSource !== undefined };
  }
  const subAllowed = claudeSubscriptionAllowed(access);
  const personalOk = subAllowed && personalSignedIn;
  if (asked === 'subscription') {
    if (!subAllowed) return { ok: false, status: 403, message: SUBSCRIPTION_NOT_ALLOWED };
    return { ok: true, patch: { modelSource: 'subscription' } };
  }
  const named = typeof config.model === 'string' && config.model.trim() ? config.model : null;
  if (named) {
    const id = companyModelId(access, named);
    if (!id) {
      // A model the platform does not name: the person's own login, as today.
      if (asked === 'company') return { ok: false, status: 403, message: MODEL_NOT_AVAILABLE };
      return { ok: true, patch: null, strip: config.modelSource !== undefined };
    }
    if (!isGrantedCompanyClaude(access, id)) {
      if (asked === 'company' || !personalOk) return { ok: false, status: 403, message: MODEL_NOT_AVAILABLE };
      return { ok: true, patch: null, strip: config.modelSource !== undefined };
    }
    if (asked !== 'company' && personalOk && access.seatFirst) return { ok: true, patch: { modelSource: 'subscription' } };
    return { ok: true, patch: { model: id, modelSource: 'company' } };
  }
  if (asked === 'company' || !personalOk) {
    const id = defaultCompanyClaude(access);
    if (id) return { ok: true, patch: { model: id, modelSource: 'company' } };
    if (asked === 'company') return { ok: false, status: 403, message: MODEL_NOT_AVAILABLE };
  }
  return { ok: true, patch: null, strip: config.modelSource !== undefined };
}

/**
 * A model switch inside a Claude Code thread. A company thread keeps its model (its env pins every
 * model Claude Code may call to it); a switch to a company model the platform does not grant is
 * refused; a personal thread cannot move onto the company model (its process has no relay env).
 * Null: allowed.
 */
export function checkClaudeModelSwitch(access: ModelAccess | null, config: Record<string, unknown>, target: string, personalSignedIn: boolean): { status: 403 | 409; message: string } | null {
  if (config.modelSource === 'company') {
    const id = access ? companyModelId(access, target) : null;
    if (!id || !isGrantedCompanyClaude(access, id)) return { status: 403, message: MODEL_NOT_AVAILABLE };
    return id === config.model ? null : { status: 409, message: COMPANY_MODEL_FIXED };
  }
  if (!access) return null;
  const id = companyModelId(access, target);
  if (!id) return null;
  if (!isGrantedCompanyClaude(access, id)) return { status: 403, message: MODEL_NOT_AVAILABLE };
  const personalOk = claudeSubscriptionAllowed(access) && personalSignedIn;
  return personalOk ? null : { status: 409, message: START_NEW_FOR_COMPANY };
}

/** True for a Claude Code thread that runs on the company model. */
export function isCompanyClaudeThread(type: string, config: Record<string, unknown> | null | undefined): boolean {
  return type === 'claude-code' && config?.modelSource === 'company' && typeof config.model === 'string' && config.model.length > 0;
}

/** The loopback relay's path under the daemon's API address (os/model-relay.ts). */
export const ANTHROPIC_RELAY_PATH = '/api/os-model/anthropic';

/** The tool a company thread may not use: the platform refuses hosted server tools. */
export const COMPANY_DISALLOWED_TOOLS: readonly string[] = ['WebSearch'];

/**
 * The env of a Claude Code process on the company model. `daemonApi` is the daemon's loopback address
 * with its base path (`http://127.0.0.1:<port><base>`); `key` is the thread's own per-thread key, the
 * same one it already has as DISPATCH_AUTH. Every model Claude Code may call is pinned to the granted
 * id, so a subagent, a summary or a title call is the same model, through the same relay.
 * CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set empty, so no other credential competes with the
 * key; the account overlay (CLAUDE_CONFIG_DIR of a saved login) is not applied to such a thread.
 */
export function companyClaudeEnv(daemonApi: string, key: string, model: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `${daemonApi.replace(/\/+$/, '')}${ANTHROPIC_RELAY_PATH}`,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // No billing attribution block in the system prompt: the platform's proxy (and the API) refuses it.
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  };
}

/** The live facts the routes and the spawner read. */
export interface CompanyModelSource {
  /** The platform's `modelAccess` now (null: absent, or the platform never answered). */
  access(): ModelAccess | null;
  /** The platform's `modelProxy` now. */
  proxy(): ModelProxy | null;
  /** Whether the person has a Claude login a thread could use (the account the thread names, else the default). */
  personalClaudeSignedIn(config: Record<string, unknown>): Promise<boolean>;
}

const NONE: CompanyModelSource = { access: () => null, proxy: () => null, personalClaudeSignedIn: async () => false };
let source: CompanyModelSource = NONE;

/** The daemon sets the source once at build. */
export function setCompanyModelSource(s: CompanyModelSource | null): void { source = s ?? NONE; }

/** The source now (a build without a platform answers "no modelAccess"). */
export function companyModels(): CompanyModelSource { return source; }
