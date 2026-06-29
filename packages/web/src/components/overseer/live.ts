// Overseer view — LIVE adapters (increment 1 of the real-data wiring; see
// docs/superpowers/specs/2026-06-29-overseer-realdata-spec.md).
//
// Pure functions that map Dispatch's structured-thread substrate (the coordinator
// conversation as ConvItem[], plus the project's structured child terminals + their
// live status) into the Overseer view-model shapes declared in types.ts. No React,
// no store, no I/O — store.ts/useRenderVals() compose these over live data and keep
// the RenderVals shape identical so overseer/components/* stay untouched.
//
// Config conventions (ride in terminals.config JSON — no migration for incr. 1):
//   coordinator → { transport: 'structured', role: 'coordinator' }            (excluded here)
//   worker      → { transport: 'structured', agentType, mission? }            (managed)

import type { ConvItem, Terminal } from '../../api/types';
import { btn, m, mission as makeMission, outc, th } from './data';
import {
  AGENT_TYPE,
  type AgentThread,
  type AgentType,
  type Mission,
  type Need,
  type Outcome,
  type StreamMessage,
  type ThreadStatus,
} from './types';

/** Per-terminal live status (mirrors stores/threadStatus.ThreadStatus). */
export interface LiveStatus {
  status?: string; // coarse persisted enum: working | needs_input | waiting | error
  threadStatus?: string; // rich normalized: starting | working | needs_input | idle | done | error
  activity?: string | null; // human label, e.g. "Editing app.ts"
}

export type StatusMap = Record<string, LiveStatus>;

const AGENT_TYPES: readonly AgentType[] = ['planner', 'implementer', 'researcher', 'reviewer'];

function asAgentType(v: unknown): AgentType {
  return typeof v === 'string' && (AGENT_TYPES as readonly string[]).includes(v)
    ? (v as AgentType)
    : 'implementer';
}

function missionName(t: Terminal): string {
  const mn = t.config?.mission;
  return typeof mn === 'string' && mn.trim() ? mn.trim() : 'General';
}

/** A stable small display number for "#id" derived from the terminal id (cosmetic). */
function displayNum(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
  return h || 1;
}

function elapsedSince(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '0m';
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

/** True for a structured worker thread the Overseer manages (i.e. not the coordinator). */
export function isManagedWorker(t: Terminal): boolean {
  if (t.type !== 'claude-code' || t.archivedAt) return false;
  const c = t.config ?? {};
  return c.transport === 'structured' && c.role !== 'coordinator';
}

/**
 * Map a thread's live status to the Overseer's coarse status (spec):
 *   working/starting → working · needs_input → waiting · idle/done/archived → done · error → error.
 */
export function mapStatus(t: Terminal, s?: LiveStatus): ThreadStatus {
  if (t.archivedAt) return 'done';
  const rich = s?.threadStatus;
  if (rich === 'working' || rich === 'starting') return 'working';
  if (rich === 'needs_input') return 'waiting';
  if (rich === 'idle' || rich === 'done') return 'done';
  if (rich === 'error') return 'error';
  switch (s?.status ?? t.status) {
    case 'working':
      return 'working';
    case 'needs_input':
      return 'waiting';
    case 'error':
      return 'error';
    case 'waiting':
      return 'done';
    default:
      return 'working';
  }
}

/** Map one structured worker terminal → an AgentThread view model (key = terminal id). */
export function terminalToAgentThread(t: Terminal, s?: LiveStatus): AgentThread {
  const type = asAgentType(t.config?.agentType);
  const status = mapStatus(t, s);
  const id = displayNum(t.id);
  const action = (s?.activity && s.activity.trim()) || missionName(t) || AGENT_TYPE[type].label;
  const elapsed = elapsedSince(t.createdAt);
  // No real progress signal in incr. 1 — show a steady mid fill while working.
  const base = th(type, id, action, status, elapsed, status === 'working' ? 50 : 100);
  return { ...base, key: t.id, dlabel: `${AGENT_TYPE[type].label} #${id} · ${missionName(t)}` };
}

function terminalToOutcome(t: Terminal): Outcome {
  const at = terminalToAgentThread(t);
  const title = missionName(t) !== 'General' ? missionName(t) : at.action || `${at.typeLabel} task`;
  const meta = at.elapsed ? `done · ${at.elapsed} ago` : 'done';
  return { ...outc(at.type, at.id, title, meta), key: t.id };
}

function summaryText(live: number, done: number): string {
  const parts: string[] = [];
  if (live) parts.push(`${live} live`);
  if (done) parts.push(`${done} done`);
  return parts.join(' · ');
}

/** The coordinator conversation (ConvItem timeline) → the Overseer message stream. */
export function convItemsToStream(items: ConvItem[]): StreamMessage[] {
  const out: StreamMessage[] = [];
  items.forEach((it, i) => {
    const key = it.uuid ?? `c${i}`;
    if (it.kind === 'user' && it.text?.trim()) out.push(m('user', 'You', it.text, '', key));
    else if (it.kind === 'assistant' && it.text?.trim()) out.push(m('overseer', 'Overseer', it.text, '', key));
    // thinking/tool/tool-result/result/system are internal: the Overseer does no tool
    // work and rich escalations are surfaced as Needs in incr. 3, not in this stream.
  });
  return out;
}

/** Group the project's structured worker threads by mission (live → working/waiting; done → outcome). */
export function groupByMission(terminals: Terminal[], statuses: StatusMap): Mission[] {
  const order: string[] = [];
  const groups = new Map<string, Terminal[]>();
  for (const t of terminals.filter(isManagedWorker)) {
    const name = missionName(t);
    if (!groups.has(name)) {
      groups.set(name, []);
      order.push(name);
    }
    groups.get(name)!.push(t);
  }
  return order.map((name) => {
    const threads: AgentThread[] = [];
    const outcomes: Outcome[] = [];
    let live = 0;
    let done = 0;
    for (const t of groups.get(name)!) {
      if (mapStatus(t, statuses[t.id]) === 'done') {
        outcomes.push(terminalToOutcome(t));
        done++;
      } else {
        threads.push(terminalToAgentThread(t, statuses[t.id]));
        live++;
      }
    }
    return makeMission(name, summaryText(live, done), threads, outcomes);
  });
}

/**
 * Coarse Needs: structured worker threads currently `needs_input` → a "waiting on you"
 * card with an "Open" action (pops the worker lightbox). Rich approve/deny/answer is incr. 3.
 * Each Need's id is the worker terminal id (also its resolve key).
 */
export function needsFromThreads(terminals: Terminal[], statuses: StatusMap): Need[] {
  return terminals
    .filter(isManagedWorker)
    .filter((t) => mapStatus(t, statuses[t.id]) === 'waiting')
    .map((t) => {
      const at = terminalToAgentThread(t, statuses[t.id]);
      const where = missionName(t);
      return {
        id: t.id,
        isQuestion: true,
        icon: 'ph-chat-teardrop-text',
        title: `${at.typeLabel} #${at.id} needs you`,
        framing:
          statuses[t.id]?.activity?.trim() ||
          `This ${at.typeLabel} is paused and waiting on your input${where !== 'General' ? ` for ${where}` : ''}.`,
        actions: [btn('Open', true)],
      } satisfies Need;
    });
}

/** Flat list of finished worker threads as Outcomes (used for the "done today" tally). */
export function outcomesFromThreads(terminals: Terminal[], statuses: StatusMap): Outcome[] {
  return terminals
    .filter(isManagedWorker)
    .filter((t) => mapStatus(t, statuses[t.id]) === 'done')
    .map((t) => terminalToOutcome(t));
}
