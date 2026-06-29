// Overseer view — view-model factories, verbatim sample data, scenario builder, and
// the single derivation function (spec §4 / §5 / §7). All denormalization lives here;
// the zustand store (store.ts) holds plain state only and reads derive() through
// useRenderVals().
//
// String content (smart quotes “”, em dashes —, the Unicode minus − in diff stats,
// the middot ·) is reproduced exactly from the source design.

import {
  AGENT_TYPE,
  STATUS,
  type AgentThread,
  type AgentType,
  type DrillStep,
  type Mission,
  type Need,
  type NeedAction,
  type Outcome,
  type Ribbon,
  type Scenario,
  type StreamMessage,
  type ThreadDetail,
  type ThreadStatus,
  type MessageKind,
  type RenderVals,
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
): Mission {
  return { name, summary, threads, outcomes, hasOutcomes: outcomes.length > 0, key: name };
}

export function m(
  kind: MessageKind,
  who: string | null,
  text: string,
  time: string,
  i: string | number,
): StreamMessage {
  return {
    kind,
    who,
    text,
    time,
    key: 's' + i,
    isUser: kind === 'user',
    isOverseer: kind === 'overseer',
    isNote: kind === 'note',
  };
}

export function btn(label: string, primary?: boolean): NeedAction {
  return primary
    ? { label, bg: 'var(--acc)', fg: '#06140B', bd: '1px solid var(--acc)' }
    : { label, bg: 'var(--pane)', fg: 'var(--ts)', bd: '1px solid var(--border)' };
}

// ---------------------------------------------------------------------------
// Canned copy (spec §7 — handler messages)
// ---------------------------------------------------------------------------

export const CANNED = {
  emptyGreeting:
    "I'm your Overseer for this project. Tell me what to move on and I'll open missions, spin up the right agents, and only surface what needs your call. I don't write code myself — so I'm always free to listen.",
  sendReply: "Captured. I'll fold it in and surface anything that needs you — keep going.",
  needAck: (label: string) => '“' + label + '” — got it. I\'ll pass it down and close this out.',
  delegateAck: (typeLabel: string, text: string) =>
    'Spun up a ' + typeLabel + ' for “' + text + '.” Tracking it now — I\'ll bring you the outcome.',
  drillNote: (dlabel: string) => 'You stepped into ' + dlabel + ". I'll keep everything else moving.",
  drillScenarioNote:
    "You stepped into implementer #4 · Auth refactor. I'll keep everything else moving and flag you if anything shifts.",
} as const;

// ---------------------------------------------------------------------------
// Verbatim sample data (spec §5 / §7)
// ---------------------------------------------------------------------------

export function baseMissions(): Mission[] {
  return [
    mission(
      'Auth refactor',
      '2 live · 1 done',
      [
        th('implementer', 4, 'Writing the JWT verify middleware', 'working', '12m', 62),
        th('reviewer', 2, 'Auditing the token-rotation approach', 'working', '3m', 40),
      ],
      [outc('planner', 1, 'Plan approved — cookie sessions, server-side rotation', 'locked in · 8m ago')],
    ),
    mission(
      'Mobile crash triage',
      '1 live · 1 done',
      [th('researcher', 7, 'Bisecting the iOS 18 crash', 'working', '6m', 30)],
      [outc('implementer', 5, 'Patched null-deref in MapView', 'PR #218 · +24 −6')],
    ),
    mission(
      'Search relevance',
      '1 live',
      [th('implementer', 9, 'Reindexing with BM25 weights', 'working', '22m', 78)],
      [],
    ),
    mission('Docs cleanup', '1 done', [], [
      outc('reviewer', 3, 'Merged — API reference fixes', 'PR #214 · +112 −80'),
    ]),
  ];
}

function needsList(): Need[] {
  return [
    {
      id: 'conflict',
      isConflict: true,
      icon: 'ph-arrows-merge',
      title: 'Direction conflict — Auth refactor',
      framing:
        "Two minutes ago you told implementer #4 to “just stash the token in localStorage.” The reviewer-approved plan calls for httpOnly cookies only. Both can't hold — here are the two sides.",
      aIcon: 'ph-seal-check',
      aLabel: 'Approved plan',
      aText:
        'httpOnly cookies, refresh rotation server-side. Tokens never reachable from JS — hardened against XSS.',
      bIcon: 'ph-user',
      bLabel: 'Your note to #4 · 2m ago',
      bText: '“just stash the token in localStorage so the SPA can read it directly”',
      actions: [btn('Keep the plan', true), btn('Switch to localStorage'), btn('Open #4 to decide')],
    },
    {
      id: 'approval',
      isApproval: true,
      icon: 'ph-shield-check',
      title: 'Permission — implementer #4',
      framing: 'To wire the new middleware, #4 needs to run:',
      cmds: ['pnpm add jose', 'edit .github/workflows/ci.yml'],
      actions: [btn('Approve', true), btn('Deny'), btn('Always allow · this mission')],
    },
    {
      id: 'question',
      isQuestion: true,
      icon: 'ph-chat-teardrop-text',
      title: 'Question — researcher #7',
      framing:
        'Reproduce on iOS 16 too, or 17+ only? It changes the device matrix and roughly doubles the run.',
      actions: [btn('17+ only', true), btn('Include 16'), btn('You choose')],
    },
  ];
}

// ---------------------------------------------------------------------------
// Scenario builder (spec §4 table) — raw (pre-derivation) data per condition.
// ---------------------------------------------------------------------------

export interface ScenarioData {
  missions: Mission[];
  needs: Need[];
  stream: StreamMessage[];
  working: number;
  done: number;
}

export function buildScenario(scenario: Scenario): ScenarioData {
  if (scenario === 'empty') {
    return {
      working: 0,
      done: 0,
      missions: [],
      needs: [],
      stream: [m('overseer', 'Overseer', CANNED.emptyGreeting, 'now', 0)],
    };
  }

  if (scenario === 'idle') {
    return {
      working: 2,
      done: 1,
      missions: [
        mission(
          'Auth refactor',
          '1 live · 1 done',
          [th('implementer', 4, 'Writing the JWT verify middleware', 'working', '12m', 62)],
          [outc('planner', 1, 'Plan approved — cookie sessions, server-side rotation', 'locked in · 8m ago')],
        ),
        mission(
          'Mobile crash triage',
          '1 live',
          [th('researcher', 7, 'Reproducing the iOS 18 crash', 'working', '4m', 30)],
          [],
        ),
      ],
      needs: [],
      stream: [
        m('user', 'You', "Let's tighten up auth before the release.", '9:02', 0),
        m(
          'overseer',
          'Overseer',
          "Opened Auth refactor and put a planner on it. I'll bring you the plan to approve — nothing ships without you.",
          '9:02',
          1,
        ),
        m(
          'overseer',
          'Overseer',
          "Plan's back and it's sound: cookie-based sessions, refresh rotation handled server-side. Approved on your standing rule. An implementer is on it now.",
          '9:14',
          2,
        ),
        m('user', 'You', 'Good. The iOS crash reports are piling up too.', '9:31', 3),
        m(
          'overseer',
          'Overseer',
          "Noted — spun up Mobile crash triage. A researcher is reproducing it first; I'll only bring you a fix worth reviewing.",
          '9:31',
          4,
        ),
      ],
    };
  }

  // active + needs (+ drill, which the store maps to active) share base missions.
  const missions = baseMissions();
  const stream: StreamMessage[] = [
    m('user', 'You', "Let's tighten up auth before the release.", '9:02', 0),
    m(
      'overseer',
      'Overseer',
      "Opened Auth refactor and put a planner on it. The plan's back and sound — cookie sessions, server-side rotation. Approved on your standing rule; an implementer and a reviewer are on it.",
      '9:14',
      1,
    ),
    m('user', 'You', 'The iOS crash reports are piling up too, and search feels stale.', '9:31', 2),
    m(
      'overseer',
      'Overseer',
      "On it — Mobile crash triage (researcher reproducing first) and Search relevance (reindexing with BM25). I'll report outcomes, not churn.",
      '9:31',
      3,
    ),
  ];

  if (scenario !== 'needs') {
    // active (and drill, which resolves to active in the store)
    return { working: 4, done: 3, missions, needs: [], stream };
  }

  // needs: flip two threads to "waiting" and surface the three escalations.
  missions[0].threads[0] = th(
    'implementer',
    4,
    'Paused — awaiting your call on token storage',
    'waiting',
    '2m',
    62,
  );
  missions[0].summary = '1 live · 1 held · 1 done';
  missions[1].threads[0] = th(
    'researcher',
    7,
    'Paused — needs the device-matrix answer',
    'waiting',
    '5m',
    30,
  );
  missions[1].summary = '1 held · 1 done';

  stream.push(
    m(
      'overseer',
      'Overseer',
      "Three things up top need you — I've framed each. The auth one's a fork in the road, not a yes/no, so I put both sides side by side.",
      '10:12',
      4,
    ),
  );

  return { working: 2, done: 3, missions, needs: needsList(), stream };
}

// ---------------------------------------------------------------------------
// Drill-in detail (spec §5 / §7)
// ---------------------------------------------------------------------------

const STEPS_BY_TYPE: Record<AgentType, { s: 'done' | 'now' | 'next'; t: string }[]> = {
  implementer: [
    { s: 'done', t: 'Read auth/session.ts and middleware/*' },
    { s: 'done', t: 'Drafted JWT verify middleware' },
    { s: 'done', t: 'Wired refresh-token rotation' },
    { s: 'now', t: 'Running auth test suite — 5 / 8 passing' },
    { s: 'next', t: 'Update CHANGELOG, open PR for review' },
  ],
  researcher: [
    { s: 'done', t: 'Pulled 142 crash reports from the last 7d' },
    { s: 'done', t: 'Clustered to a single MapView null-deref' },
    { s: 'now', t: 'Bisecting builds to find the regression' },
    { s: 'next', t: 'Hand a minimal repro to an implementer' },
  ],
  reviewer: [
    { s: 'done', t: 'Read the proposed rotation flow' },
    { s: 'now', t: 'Checking it against OWASP session guidance' },
    { s: 'next', t: 'Return a verdict + risks to the Overseer' },
  ],
  planner: [
    { s: 'done', t: 'Surveyed current auth surface' },
    { s: 'now', t: 'Drafting the migration plan' },
    { s: 'next', t: 'Hand the plan up for your approval' },
  ],
};

export function detail(key: string, missions: Mission[]): ThreadDetail {
  let found: AgentThread | null = null;
  let mname = '';
  missions.forEach((mi) =>
    mi.threads.forEach((t) => {
      if (t.key === key) {
        found = t;
        mname = mi.name;
      }
    }),
  );
  if (!found) {
    found = th('implementer', 4, 'Writing the JWT verify middleware', 'working', '12m', 62);
    mname = 'Auth refactor';
  }
  // `found` is definitely assigned above; alias to a non-null local for TS narrowing.
  const thread: AgentThread = found;

  const raw = STEPS_BY_TYPE[thread.type] || STEPS_BY_TYPE.implementer;
  const steps: DrillStep[] = raw.map((st, i) => ({
    key: 'st' + i,
    text: st.t,
    icon: st.s === 'done' ? 'ph-check' : st.s === 'now' ? 'ph-circle-notch' : 'ph-circle',
    color: st.s === 'next' ? 'var(--tt)' : 'var(--acc)',
    textColor: st.s === 'next' ? 'var(--tt)' : st.s === 'now' ? 'var(--tp)' : 'var(--ts)',
    anim: st.s === 'now' ? 'spin 1.4s linear infinite' : 'none',
    isNow: st.s === 'now',
  }));

  return {
    typeIcon: AGENT_TYPE[thread.type].icon,
    typeLabel: thread.typeLabel,
    id: thread.id,
    statusLabel: thread.statusLabel,
    dotColor: thread.dotColor,
    dotAnim: thread.dotAnim,
    mission: mname,
    elapsed: thread.elapsed,
    action: thread.action,
    steps,
    surface: "When tests pass I'll bring you the PR to review — not before.",
  };
}

// ---------------------------------------------------------------------------
// derive() — the single source for RenderVals (spec §4 derivations)
// ---------------------------------------------------------------------------

// The subset of store state derive() reads. (Kept structural so the store can pass
// itself or a shallow slice.)
export interface DeriveState {
  scenario: Scenario;
  drill: string | null;
  extra: StreamMessage[];
  resolved: string[];
  spawned: AgentThread[];
}

export function derive(s: DeriveState): RenderVals {
  const data = buildScenario(s.scenario);

  // approving/denying a need removes its card live
  const needs = data.needs.filter((n) => !s.resolved.includes(n.id));

  // clone missions; prepend spawned threads to missions[0]; add dlabel to every thread
  let missions = data.missions.map((mm) => ({ ...mm }));
  if (s.spawned.length && missions[0]) {
    missions[0] = { ...missions[0], threads: [...s.spawned, ...missions[0].threads] };
  }
  missions = missions.map((mm) => ({
    ...mm,
    threads: mm.threads.map((t) => ({ ...t, dlabel: t.typeLabel + ' #' + t.id + ' · ' + mm.name })),
  }));

  const stream = [...data.stream, ...s.extra];

  const hasNeeds = needs.length > 0;
  const moodText = hasNeeds
    ? needs.length + (needs.length === 1 ? ' thing needs you' : ' things need you')
    : s.scenario === 'empty'
      ? 'Ready when you are'
      : 'Calm — nothing needs you';

  const ribbon: Ribbon = {
    working: data.working,
    done: data.done,
    needs: needs.length,
    hasNeeds,
    moodText,
  };

  return {
    ribbon,
    needs,
    missions,
    stream,
    drillDetail: s.drill ? detail(s.drill, missions) : null,
    hasNeeds,
    noMissions: missions.length === 0,
    emptyMode: s.scenario === 'empty',
    drillOpen: !!s.drill,
    overviewOpen: !s.drill,
  };
}
