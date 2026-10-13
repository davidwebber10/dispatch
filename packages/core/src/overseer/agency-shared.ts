/**
 * The agency tools' shared parts, used by the Control Plane's agency MCP server
 * (overseer/agency-mcp.ts) and the Endless Chat memory MCP server (endless/memory-mcp.ts):
 * the HTTP helper, worker creation, the output read, and the fixed schema texts. Every
 * function takes the daemon base URL and, where a project is needed, its session id as
 * arguments. Nothing here reads DISPATCH_SESSION.
 */
import { buildWorkerCreateBody } from './worker-payload.js';

export const AGENT_TYPES = ['planner', 'implementer', 'researcher', 'reviewer', 'design-reviewer', 'code-reviewer'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];
export const HARNESSES = ['claude-code', 'codex', 'grok', 'opencode'] as const;

/** spawn_agent/queue_agent `harness` arg. It must say that `model` never picks the harness: a
 *  coordinator that passed model "gpt-6-astra" alone got claude-code workers that could not run. */
export const HARNESS_ARG_DESCRIPTION =
  'Optional harness (agent CLI) for this worker. Omit to use the configured default: ' +
  'the per-agent-type worker matrix, else the session default the user picked, else claude-code. ' +
  'The model never picks the harness: pass harness with any non-Claude model ' +
  '(e.g. harness "codex" with model "gpt-6-astra"). Otherwise override only when the task clearly ' +
  'benefits from a specific harness.';

/** The title rules, for each tool that takes a title (titles and source panel spec 2026-10-09, Unit 2). */
export const TITLE_RULES =
  'A short title that chips, card rows and recap lines show instead of the question: one line, at least 2 words, ' +
  'about 40 characters (50 at most), never only a code such as N41 or Q12, e.g. "Merge board PR #26".';

/** The decision-card fields of ledger_add and ledger_import (decision cards spec 2026-10-06, Unit 1). */
export const CARD_FIELDS_SCHEMA = {
  context: { type: 'string', description: 'Go/decide: what the user needs to know to decide, 20 to 800 characters.' },
  options: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'The option, e.g. "A. 5 nights".' },
        effect: { type: 'string', description: 'What happens if the user picks it.' },
      },
      required: ['label', 'effect'],
    },
    description: 'Decide: at least 2 options. Go: optional.',
  },
  recommendation: { type: 'string', description: 'When options exist: exactly one of the option labels.' },
  why: { type: 'string', description: 'When options exist: the reason for the recommendation.' },
  default: { type: 'string', description: 'Go/decide: what happens if the user does not answer. "Nothing happens" is valid.' },
  source: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['plan', 'doc', 'agent', 'thread', 'pr', 'issue', 'user', 'overseer'] },
      ref: {
        type: 'string',
        description: 'plan/doc: a path relative to the project (it must exist); agent: its label or ID; ' +
          'thread: the label or ID of one of the user\'s own threads in this project (not an agent, not you); ' +
          'pr/issue: "#123"; user: the user\'s exact words; overseer: not needed.',
      },
      section: { type: 'string', description: 'Optional: the section inside the source.' },
      id: { type: 'string', description: 'Optional: the source\'s own ID, e.g. "LR-6" (a cross-reference only).' },
    },
    required: ['kind'],
    description: 'Go/decide: where the decision comes from. The daemon checks that it exists.',
  },
  note: { type: 'string', description: 'Optional: your own note, shown as "Overseer\'s note".' },
} as const;

export async function httpJson(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`${method} ${url} -> ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }
  const text = await res.text().catch(() => '');
  if (!text) return null; // 204 / empty body
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Resolve harness/model through the daemon's single tested place (matrix + session default +
 * availability guard): GET .../overseer/worker-defaults. An explicit `harness` goes THROUGH the
 * endpoint as `?harness=`, so the availability guard always runs.
 */
export async function resolveWorkerDefaults(api: string, sessionId: string, agentType: AgentType, harness: string): Promise<{ harness: string; model?: string }> {
  const url = `${api}/api/sessions/${sessionId}/overseer/worker-defaults?agentType=${encodeURIComponent(agentType)}${harness ? `&harness=${encodeURIComponent(harness)}` : ''}`;
  const defaults = await httpJson('GET', url) as { harness: string; model?: string; available: boolean; reason?: string };
  if (!defaults.available) throw new Error(defaults.reason || `${defaults.harness} is not available on this server`);
  return { harness: defaults.harness, model: defaults.model };
}

export interface WorkerSpec { agentType: AgentType; label: string; mission: string; model: string; harness: string; spawnDepth: number; origin?: 'endless' }

/** Create a worker thread in project `sessionId` and return its id. The caller sends the task. */
export async function createWorker(api: string, sessionId: string, spec: WorkerSpec): Promise<string> {
  const resolved = await resolveWorkerDefaults(api, sessionId, spec.agentType, spec.harness);
  const terminal = await httpJson('POST', `${api}/api/sessions/${sessionId}/terminals`,
    buildWorkerCreateBody({ agentType: spec.agentType, label: spec.label, resolved, explicitModel: spec.model, mission: spec.mission, spawnDepth: spec.spawnDepth, origin: spec.origin }));
  const agentId: string | undefined = terminal?.id;
  if (!agentId) throw new Error('spawn did not return a terminal id');
  return agentId;
}

/** Seed or steer a thread: the message route takes it on either transport. */
export async function sendTask(api: string, terminalId: string, text: string): Promise<void> {
  await httpJson('POST', `${api}/api/terminals/${terminalId}/message`, { text, source: 'coordinator' });
}

/** An agent's assistant output, the tools it ran (last 30) and its status. */
export async function readAgentOutput(api: string, agentId: string): Promise<{ agentId: string; status: string | null; output: string; tools: string[] }> {
  const conv = await httpJson('GET', `${api}/api/terminals/${agentId}/conversation?limit=500`);
  const items: any[] = Array.isArray(conv?.items) ? conv.items : [];
  const output = items.filter((it) => it?.kind === 'assistant' && it.text).map((it) => it.text).join('\n\n').trim();
  const tools = items.filter((it) => it?.kind === 'tool' && it.toolName).map((it) => it.toolName as string);
  let status: string | null = null;
  try { const t = await httpJson('GET', `${api}/api/terminals/${agentId}`); status = t?.status ?? null; } catch { /* ignore */ }
  return { agentId, status, output: output || '(no assistant output captured yet)', tools: tools.slice(-30) };
}
