// packages/core/src/os/os-servers.ts
// One MCP server per company system (2026-11-11, replaces the single company-tools server).
//
// OS serves every company tool at ONE gateway endpoint, each tool named `<system>_<action>` with a
// `system` field (`acumatica_get_customer`, system `acumatica`; OS's own `os_list_connections`,
// system `os`). A thread sees each system as its OWN server instead:
//
//   gateway tool              thread server     thread tool      Claude Code name
//   acumatica_get_customer    acumatica         get_customer     mcp__acumatica__get_customer
//   google_drive_search       google-drive      search           mcp__google-drive__search
//   os_list_connections       connections       list             mcp__connections__list
//
// The mapping back to the gateway name happens in the box (os/tools-proxy.ts, the per-system loopback
// route), so the gateway needs no change: the route sends `x-dispatch-systems: <system>` and the real
// tool name. A server the person added under the same name keeps it; the OS one becomes `os-<name>`.
//
// Pure functions only: no I/O here.
import type { McpServerSpec } from '../mcp/injection.js';

/** OS's own system (the connections tool). */
export const OS_SELF_SYSTEM = 'os';
/** The server name of OS's own system. */
export const CONNECTIONS_SERVER = 'connections';

/** Gateway names that do not follow `<system>_<action>` well, by system: real name -> thread name. */
const ALIASES: Record<string, Record<string, string>> = {
  [OS_SELF_SYSTEM]: { os_list_connections: 'list' },
};

/** A system id OS may send: letters, digits, `_`, `-`, `.`. Anything else gets no server. */
export function isSystemId(s: unknown): s is string {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(s);
}

/** The server name of a system before collisions: `os` -> `connections`, `google_drive` -> `google-drive`. */
export function serverNameFor(system: string): string {
  if (system === OS_SELF_SYSTEM) return CONNECTIONS_SERVER;
  return system.toLowerCase().replace(/[_.]/g, '-');
}

/**
 * The system of one gateway tool: its `system` field (top level, `_meta` or `annotations`), else the
 * longest known system id that prefixes the name, else the name's first segment.
 */
export function toolSystem(tool: unknown, known: readonly string[] = []): string | null {
  const o = (tool && typeof tool === 'object' ? tool : {}) as Record<string, any>;
  for (const v of [o.system, o._meta?.system, o.annotations?.system]) if (isSystemId(v)) return v;
  const name = typeof o.name === 'string' ? o.name : '';
  const hit = [...known].filter((k) => name.startsWith(k + '_')).sort((a, b) => b.length - a.length)[0];
  if (hit) return hit;
  return /^([a-z0-9]+)_/i.exec(name)?.[1] ?? null;
}

/** The thread's name of a gateway tool: the system prefix dropped (`acumatica_get_customer` -> `get_customer`). */
export function localToolName(system: string, realName: string): string {
  const alias = ALIASES[system]?.[realName];
  if (alias) return alias;
  return realName.startsWith(system + '_') && realName.length > system.length + 1 ? realName.slice(system.length + 1) : realName;
}

/**
 * The gateway's name of a thread tool. `known`: the real names OS listed for this system (the
 * catalog); without a match the prefix is put back.
 */
export function realToolName(system: string, local: string, known: readonly string[] = []): string {
  for (const real of known) if (localToolName(system, real) === local) return real;
  const alias = Object.entries(ALIASES[system] ?? {}).find(([, l]) => l === local)?.[0];
  if (alias) return alias;
  return local.startsWith(system + '_') ? local : `${system}_${local}`;
}

/** A gateway tool definition renamed for a thread (everything else as OS wrote it). */
export function renameTool<T extends Record<string, unknown>>(system: string, tool: T): T {
  const name = typeof tool.name === 'string' ? tool.name : '';
  return { ...tool, name: localToolName(system, name) };
}

export interface OsServerSpecInput {
  /** The daemon's loopback address (DISPATCH_API, base path included). */
  daemonApi: string;
  /** The systems that get a server, in order. */
  systems: readonly string[];
  /** The stdio bridge script (a harness that cannot take a loopback HTTP entry runs it). */
  bridgePath: string;
}

/** The loopback route of one system's server. */
export function systemRoute(daemonApi: string, system: string): string {
  return `${daemonApi.replace(/\/+$/, '')}/api/os/mcp/${encodeURIComponent(system)}`;
}

/**
 * One spec per system. Each carries BOTH ways to reach it: `http` (a loopback HTTP entry with the
 * thread key as `Authorization: Bearer ${DISPATCH_AUTH}`, no extra process) and the stdio bridge
 * (command/args, for a harness that cannot send the key in an HTTP header without a literal).
 * mcp/injection.ts picks per harness. `authEnv`: the key is a reference, never a literal in a file.
 */
export function osServerSpecs(input: OsServerSpecInput): McpServerSpec[] {
  const out: McpServerSpec[] = [];
  const seen = new Set<string>();
  for (const system of input.systems) {
    if (!isSystemId(system) || seen.has(system)) continue;
    seen.add(system);
    out.push({
      name: serverNameFor(system),
      command: 'node',
      args: [input.bridgePath],
      env: { DISPATCH_API: input.daemonApi, DISPATCH_OS_SYSTEM: system },
      authEnv: true,
      http: { url: systemRoute(input.daemonApi, system) },
      osSystem: system,
    });
  }
  return out;
}

/**
 * Name collisions. A server that is not an OS system (the person's own, an integration, a plugin,
 * Dispatch's own) keeps its name; an OS server with the same name becomes `os-<name>`. `taken`: more
 * names in use outside `specs` (the person's own Claude config). Returns a new list.
 */
export function resolveOsServerNames(specs: readonly McpServerSpec[], taken: Iterable<string> = []): McpServerSpec[] {
  const used = new Set<string>(taken);
  for (const s of specs) if (!s.osSystem) used.add(s.name);
  const out: McpServerSpec[] = [];
  for (const s of specs) {
    if (!s.osSystem) { out.push(s); continue; }
    let name = s.name;
    if (used.has(name)) name = `os-${s.name}`;
    for (let i = 2; used.has(name); i++) name = `os-${s.name}-${i}`;
    used.add(name);
    out.push(name === s.name ? s : { ...s, name });
  }
  return out;
}

/** The names of the OS servers in a spec list (what smart approvals treat as company tools). */
export function osServerNames(specs: readonly McpServerSpec[]): string[] {
  return specs.filter((s) => s.osSystem).map((s) => s.name);
}

/** The one line a thread reads about its company systems (OS's own prompt may still name an older layout). */
export function osServersNote(specs: readonly McpServerSpec[], platformName: string): string | null {
  const os = specs.filter((s) => s.osSystem);
  if (os.length === 0) return null;
  const systems = os.filter((s) => s.osSystem !== OS_SELF_SYSTEM).map((s) => s.name);
  const conn = os.find((s) => s.osSystem === OS_SELF_SYSTEM)?.name;
  const parts: string[] = [];
  if (systems.length) parts.push(`Company systems from ${platformName} are MCP servers of their own: ${systems.join(', ')}.`);
  if (conn) parts.push(`The \`list\` tool of the \`${conn}\` server shows which company systems are connected.`);
  return parts.join(' ');
}

// ── The gateway's instructions ─────────────────────────────────────────────────
// OS's `initialize` answer carries `instructions` (how to use the data tools, the display markers).
// With one server per system they ride ONE server: `data` when the person has it, else `connections`.
// The text names tools the gateway's way (`data_guide`, `display_chart`); a thread sees them as the
// `guide` tool of the `data` server, so each gateway name the catalog knows is written `<server>.<tool>`.

/** The built-in system that carries the instructions when present (2026-11-11 gateway). */
export const INSTRUCTIONS_SYSTEM = 'data';

/** The system whose server carries the gateway's instructions, among the systems a thread gets. */
export function instructionsHome(systems: readonly string[]): string | null {
  if (systems.includes(INSTRUCTIONS_SYSTEM)) return INSTRUCTIONS_SYSTEM;
  if (systems.includes(OS_SELF_SYSTEM)) return OS_SELF_SYSTEM;
  return systems[0] ?? null;
}

/**
 * The gateway text with every known gateway tool name written as the thread sees it. `tools`: per
 * system, the real names (the catalog); `serverOf`: the server name a system has in this thread.
 */
export function rewriteInstructions(text: string, tools: ReadonlyMap<string, readonly string[]> | Record<string, readonly string[]>, serverOf: (system: string) => string = serverNameFor): string {
  const entries = tools instanceof Map ? [...tools.entries()] : Object.entries(tools);
  const pairs: Array<[string, string]> = [];
  for (const [system, reals] of entries) for (const real of reals) pairs.push([real, `${serverOf(system)}.${localToolName(system, real)}`]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = text.replace(/<server>_<tool>/g, '<server>.<tool>');
  if (pairs.length === 0) return out;
  const re = new RegExp(`(?<![A-Za-z0-9_.])(${pairs.map(([r]) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9_])`, 'g');
  const map = new Map(pairs);
  out = out.replace(re, (m) => map.get(m) ?? m);
  return out;
}

/** What the box last learned from the gateway: its instructions and its tool names per system. */
let gateway: { instructions: string | null; tools: Map<string, string[]> } = { instructions: null, tools: new Map() };
export function setGatewayInfo(info: { instructions: string | null; tools: Map<string, string[]> }): void { gateway = info; }
export function gatewayInfo(): { instructions: string | null; tools: Map<string, string[]> } { return gateway; }

/**
 * Harnesses that do not put an MCP server's `instructions` into the model's context, so the box adds
 * the text to their system prompt instead. Measured 2026-11-11 by capturing the model request: Claude
 * Code 2.1.322 and Codex 0.167 send the instructions; OpenCode 1.19 and Grok could not be measured,
 * so they get the prompt copy (a copy too many costs tokens; a copy too few loses the rules).
 */
export const PROMPT_INSTRUCTIONS_HARNESSES: readonly string[] = ['opencode', 'grok'];

// ── Which servers smart approvals count as company tools ───────────────────────
// The names change per thread (collisions) and per person (systems), so the spawner sets them here
// and the static rules (os/approvals.ts) read them.
let currentOsServers: readonly string[] = [];
export function setCurrentOsServerNames(names: readonly string[]): void {
  const merged = new Set([...currentOsServers, ...names]);
  currentOsServers = [...merged];
}
export function currentOsServerNames(): readonly string[] { return currentOsServers; }
/** Tests only. */
export function resetCurrentOsServerNames(): void { currentOsServers = []; }
