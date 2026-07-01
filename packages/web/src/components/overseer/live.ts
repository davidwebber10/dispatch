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

import type { ConvItem, PendingPermission, PermissionQuestion, Terminal } from '../../api/types';
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

/**
 * The agent's OWN distinct display name — `terminal.label`, the same string the
 * WorkerLightbox shows as its title (see overseer/components/WorkerLightbox.tsx). This is
 * per-agent, unlike `missionName` which every agent in a group shares. Falls back to the
 * type label (e.g. "implementer") when a worker was spawned without an explicit name.
 */
function agentName(t: Terminal, type: AgentType): string {
  const l = typeof t.label === 'string' ? t.label.trim() : '';
  return l || AGENT_TYPE[type].label;
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

/**
 * The best "last active" instant (epoch ms) for ordering FINISHED work newest-first:
 * the live activity stamp when present, else the archive time, else creation. Returns 0
 * for an absent/unparseable stamp so those rows sink to the bottom rather than NaN-poison
 * the sort.
 */
function lastActiveMs(t: Terminal): number {
  const iso = t.lastActivityAt || t.archivedAt || t.createdAt;
  const ms = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * A structured worker terminal (typed agent, not the coordinator), IGNORING archive
 * state. Used directly for the separately-fetched archived list so completed
 * (complete_agent'd) agents can still surface as outcomes; the live rail uses
 * isManagedWorker, which additionally rejects archived rows.
 */
export function isStructuredWorker(t: Terminal): boolean {
  if (t.type !== 'claude-code') return false;
  const c = t.config ?? {};
  return c.transport === 'structured' && c.role !== 'coordinator';
}

/** True for a LIVE structured worker thread the Overseer manages (i.e. not the coordinator, not archived). */
export function isManagedWorker(t: Terminal): boolean {
  return !t.archivedAt && isStructuredWorker(t);
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
  const name = agentName(t, type);
  // The chip's identity line shows THIS agent's own name — never the mission (that is the
  // group header). A live activity string, when we have one, is more specific so it wins;
  // absent that, we fall back to the agent name, not the shared mission.
  const action = (s?.activity && s.activity.trim()) || name;
  const elapsed = elapsedSince(t.createdAt);
  // No real progress signal in incr. 1 — show a steady mid fill while working.
  const base = th(type, id, action, status, elapsed, status === 'working' ? 50 : 100);
  // dlabel is the drill-in / data-label name; keep it the agent's own name so the rail and
  // the opened WorkerLightbox agree on identity.
  return { ...base, key: t.id, dlabel: name };
}

function terminalToOutcome(t: Terminal): Outcome {
  const at = terminalToAgentThread(t);
  // Outcome cards are entries too → title with the agent's own name, not the mission.
  const title = at.dlabel || at.action || `${at.typeLabel} task`;
  const meta = at.elapsed ? `done · ${at.elapsed} ago` : 'done';
  return { ...outc(at.type, at.id, title, meta), key: t.id };
}

function summaryText(live: number, done: number): string {
  const parts: string[] = [];
  if (live) parts.push(`${live} live`);
  if (done) parts.push(`${done} done`);
  return parts.join(' · ');
}

/**
 * An 'image' ConvItem → an image StreamMessage. Constructed inline (not via the m()
 * factory, which only knows text kinds) so it stays disjoint from data.ts; carries the
 * already-resolved src/alt straight through to <ChatImage>. Key matches m()'s "s"+i scheme.
 * `fromUser` marks a picture the HUMAN attached on their own turn so the stream attributes
 * it to "You" (right-aligned) instead of rendering it as a Dispatch turn.
 */
function imageMessage(imageUrl: string, imageAlt: string | undefined, i: string, fromUser: boolean): StreamMessage {
  return {
    kind: 'image',
    who: fromUser ? 'You' : null,
    text: '',
    time: '',
    key: `s${i}`,
    isUser: fromUser,
    isOverseer: false,
    isNote: false,
    isImage: true,
    imageUrl,
    imageAlt,
  };
}

/** The coordinator conversation (ConvItem timeline) → the Overseer message stream. */
export function convItemsToStream(items: ConvItem[]): StreamMessage[] {
  const out: StreamMessage[] = [];
  items.forEach((it, i) => {
    const key = it.uuid ?? `c${i}`;
    if (it.kind === 'user' && it.text?.trim()) out.push(m('user', 'You', it.text, '', key));
    else if (it.kind === 'assistant' && it.text?.trim()) out.push(m('overseer', 'Dispatch', it.text, '', key));
    else if (it.kind === 'image' && it.imageUrl) out.push(imageMessage(it.imageUrl, it.imageAlt, key, it.imageFromUser === true));
    // thinking/tool/tool-result/result/system are internal: the Overseer does no tool
    // work and rich escalations are surfaced as Needs in incr. 3, not in this stream.
  });
  return out;
}

/**
 * Group the project's structured worker threads by mission (live → working/waiting;
 * done → outcome). Archived workers (completed via complete_agent — fetched separately
 * since the live list excludes archived_at) fold in as done outcomes so they stay
 * visible and clickable instead of vanishing. De-duped against the live set by id so a
 * just-archived agent never shows twice while the live list catches up.
 */
export function groupByMission(
  terminals: Terminal[],
  statuses: StatusMap,
  archived: Terminal[] = [],
): Mission[] {
  const order: string[] = [];
  const groups = new Map<string, { live: Terminal[]; archived: Terminal[] }>();
  const ensure = (name: string) => {
    let g = groups.get(name);
    if (!g) {
      g = { live: [], archived: [] };
      groups.set(name, g);
      order.push(name);
    }
    return g;
  };

  const liveIds = new Set<string>();
  for (const t of terminals.filter(isManagedWorker)) {
    liveIds.add(t.id);
    ensure(missionName(t)).live.push(t);
  }
  for (const t of archived.filter(isStructuredWorker)) {
    if (liveIds.has(t.id)) continue; // de-dupe: live list wins while it catches up
    ensure(missionName(t)).archived.push(t);
  }

  return order.map((name) => {
    const g = groups.get(name)!;
    const threads: AgentThread[] = [];
    const doneTerminals: Terminal[] = [];
    let live = 0;
    for (const t of g.live) {
      if (mapStatus(t, statuses[t.id]) === 'done') {
        doneTerminals.push(t);
      } else {
        threads.push(terminalToAgentThread(t, statuses[t.id]));
        live++;
      }
    }
    // archived → mapStatus()='done' (archivedAt set); folds in with the just-finished live rows.
    doneTerminals.push(...g.archived);
    // Finished work sorts newest-active first so the freshest outcome sits at the top of the
    // group (LIVE `threads` are left in their original order — the Live tab is untouched).
    doneTerminals.sort((a, b) => lastActiveMs(b) - lastActiveMs(a));
    const outcomes = doneTerminals.map(terminalToOutcome);
    // `doneFreshness` = the group's most-recent finished stamp (0 if none). Additive tag the
    // Done tab reads to float the freshest MISSION to the top without reordering the shared
    // Mission[] (which would disturb the Live tab) — see WorkRail's Done branch.
    const doneFreshness = doneTerminals.length ? lastActiveMs(doneTerminals[0]) : 0;
    return { ...makeMission(name, summaryText(live, doneTerminals.length), threads, outcomes), doneFreshness };
  });
}

type QuestionOption = NonNullable<PermissionQuestion['options']>[number];

/** The display label for an AskUserQuestion option (string or {label,name}). */
export function optionLabel(o: QuestionOption): string {
  if (typeof o === 'string') return o;
  return (o?.label ?? o?.name ?? '').toString() || 'Option';
}

/** A compact one-line summary of a gated tool's input (the command/path it wants to run). */
function commandFromPending(pending: PendingPermission): string {
  const inp = (pending.input ?? {}) as Record<string, unknown>;
  if (typeof inp.command === 'string') return inp.command;
  if (typeof inp.file_path === 'string') return `${pending.toolName} ${inp.file_path}`;
  if (typeof inp.path === 'string') return `${pending.toolName} ${inp.path}`;
  try {
    const s = JSON.stringify(inp);
    if (s && s !== '{}') return `${pending.toolName} ${s.length > 120 ? s.slice(0, 117) + '…' : s}`;
  } catch { /* fall through */ }
  return pending.toolName;
}

/**
 * Build a REAL Need from an agent thread's pending escalation:
 *   - AskUserQuestion (questions[]) → a 'question' Need; each option is an action button.
 *   - any other gated tool → an 'approval' Need showing the tool + command, Approve/Deny.
 * The Need id is the worker terminal id (the resolve key); store.needAction maps the
 * clicked label back to an api.answerPermission call.
 */
export function needFromPending(t: Terminal, at: AgentThread, pending: PendingPermission): Need {
  const q = pending.questions?.[0];
  if (q) {
    const opts = Array.isArray(q.options) ? q.options : [];
    const actions = opts.map((o, i) => btn(optionLabel(o), i === 0));
    return {
      id: t.id,
      isQuestion: true,
      icon: 'ph-chat-teardrop-text',
      title: q.header ? `${q.header} — ${at.typeLabel} #${at.id}` : `Question — ${at.typeLabel} #${at.id}`,
      framing: q.question || `This ${at.typeLabel} needs your input.`,
      actions: actions.length ? actions : [btn('Open', true)],
    } satisfies Need;
  }
  return {
    id: t.id,
    isApproval: true,
    icon: 'ph-shield-check',
    title: `Permission — ${at.typeLabel} #${at.id}`,
    framing: `To continue, this ${at.typeLabel} needs to use ${pending.toolName}.`,
    cmds: [commandFromPending(pending)],
    actions: [btn('Approve', true), btn('Deny')],
  } satisfies Need;
}

/**
 * Needs from the project's structured worker threads currently `needs_input`. When the
 * thread's pending escalation has been fetched (pendings[id]) we render a REAL approve/
 * deny/answer card; otherwise we fall back to a coarse "waiting on you" card with Open.
 * Each Need's id is the worker terminal id (also its resolve key).
 */
export function needsFromThreads(
  terminals: Terminal[],
  statuses: StatusMap,
  pendings: Record<string, PendingPermission | null | undefined> = {},
): Need[] {
  return terminals
    .filter(isManagedWorker)
    .filter((t) => mapStatus(t, statuses[t.id]) === 'waiting')
    .map((t) => {
      const at = terminalToAgentThread(t, statuses[t.id]);
      const pending = pendings[t.id];
      if (pending) return needFromPending(t, at, pending);
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
