// Overseer view — the view-model factories that the live Control Plane uses (live.ts) and the
// canned copy (store.ts, Stream.tsx). The mock scenario builder, its sample data and its
// derive() function were removed on 2026-11-09 (W1-G): nothing imported them.
//
// String content (smart quotes “”, em dashes —, the Unicode minus − in diff stats,
// the middot ·) is reproduced exactly from the source design.

import {
  AGENT_TYPE,
  STATUS,
  type AgentThread,
  type AgentType,
  type Mission,
  type NeedAction,
  type Outcome,
  type ThreadStatus,
} from './types';

// ---------------------------------------------------------------------------
// Factories (denormalize the registries into render-ready view models)
// ---------------------------------------------------------------------------

export function th(
  type: AgentType,
  id: number,
  action: string,
  status: ThreadStatus,
  elapsed: string,
  progress: number,
): AgentThread {
  const t = AGENT_TYPE[type];
  const s = STATUS[status];
  return {
    type,
    id,
    action,
    elapsed,
    typeIcon: t.icon,
    typeLabel: t.label,
    statusLabel: s.label,
    dotColor: s.color,
    isWorking: status === 'working',
    isWaiting: status === 'waiting',
    isDone: status === 'done',
    isScheduled: status === 'scheduled',
    dotAnim: status === 'working' ? 'breathe var(--pulse) ease-in-out infinite' : 'none',
    progressW: (progress || 0) + '%',
    showProgress: status === 'working',
    metaRight: status === 'working' ? elapsed : status === 'waiting' ? 'held ' + elapsed : elapsed,
    key: type + id,
  };
}

export function outc(type: AgentType, id: number, title: string, meta: string): Outcome {
  const t = AGENT_TYPE[type];
  return { type, id, title, meta, typeLabel: t.label, key: 'o' + type + id };
}

export function mission(
  name: string,
  summary: string,
  threads: AgentThread[],
  outcomes: Outcome[],
  queued: AgentThread[] = [],
): Mission {
  return { name, summary, threads, queued, outcomes, hasOutcomes: outcomes.length > 0, key: name };
}

export function btn(label: string, primary?: boolean): NeedAction {
  return primary
    ? { label, bg: 'var(--acc)', fg: 'var(--color-on-accent)', bd: '1px solid var(--acc)' }
    : { label, bg: 'var(--pane)', fg: 'var(--ts)', bd: '1px solid var(--border)' };
}

// ---------------------------------------------------------------------------
// Canned copy (spec §7 — handler messages)
// ---------------------------------------------------------------------------

export const CANNED = {
  /** `name` is the coordinator name from Settings (useDispatchName). */
  emptyGreeting: (name: string) =>
    "I'm " + name + " — the coordinator for this project. Tell me what to move on and I'll open missions, spin up the right agents, and only surface what needs your call. I don't write code myself — so I'm always free to listen.",
  sendReply: "Captured. I'll fold it in and surface anything that needs you — keep going.",
  needAck: (label: string) => '“' + label + '” — got it. I\'ll pass it down and close this out.',
  delegateAck: (typeLabel: string, text: string) =>
    'Spun up a ' + typeLabel + ' for “' + text + '.” Tracking it now — I\'ll bring you the outcome.',
  drillNote: (dlabel: string) => 'You stepped into ' + dlabel + ". I'll keep everything else moving.",
  drillScenarioNote:
    "You stepped into implementer #4 · Auth refactor. I'll keep everything else moving and flag you if anything shifts.",
} as const;
