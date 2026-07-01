// Overseer view — TypeScript contract (spec §5, verbatim).
//
// These are the *view-model* shapes the Overseer module renders. The denormalized
// fields on AgentThread/Outcome/etc. are derived in data.ts from the AGENT_TYPE /
// STATUS registries below (see spec §10 "production notes"). Keep derivation in
// data.ts — the store stays a plain state bag.

export type AgentType = 'planner' | 'implementer' | 'researcher' | 'reviewer';
export type ThreadStatus = 'working' | 'waiting' | 'done' | 'error' | 'queued';
export type MessageKind = 'user' | 'overseer' | 'note' | 'image';

// TYPE registry — phosphor class + display label per agent type.
export const AGENT_TYPE = {
  planner:     { icon: 'ph-compass',          label: 'planner' },
  implementer: { icon: 'ph-code',             label: 'implementer' },
  researcher:  { icon: 'ph-magnifying-glass', label: 'researcher' },
  reviewer:    { icon: 'ph-seal-check',       label: 'reviewer' },
} as const;

// STATUS registry — dot color + label per status.
export const STATUS = {
  working: { color: 'var(--acc)',    label: 'working' },
  waiting: { color: 'var(--yellow)', label: 'waiting on you' },
  done:    { color: 'var(--ts)',     label: 'done' },
  error:   { color: 'var(--red)',    label: 'error' },
  queued:  { color: 'var(--tt)',     label: 'queued' },
} as const;

// An ephemeral typed agent thread (factory: th(type,id,action,status,elapsed,progress)).
export interface AgentThread {
  type: AgentType;
  id: number;                 // display number, e.g. 4
  action: string;             // one-line current action
  elapsed: string;            // "12m"
  // derived/denormalized for render:
  typeIcon: string;           // 'ph-code'
  typeLabel: string;          // 'implementer'
  statusLabel: string;        // 'working' | 'waiting on you' | 'done'
  dotColor: string;           // css var
  isWorking: boolean;
  isWaiting: boolean;
  isDone: boolean;
  dotAnim: string;            // "breathe var(--pulse) ease-in-out infinite" | "none"
  progressW: string;          // "62%"
  showProgress: boolean;      // true only when status==='working'
  metaRight: string;          // working→elapsed, waiting→"held "+elapsed, else elapsed
  key: string;                // type+id, e.g. "implementer4"
  dlabel?: string;            // added later: "implementer #4 · Auth refactor"
}

// A finished thread, collapsed (factory: outc(type,id,title,meta)).
export interface Outcome {
  type: AgentType;
  id: number;
  title: string;              // "Patched null-deref in MapView"
  meta: string;               // "PR #218 · +24 −6" / "locked in · 8m ago"
  typeLabel: string;          // 'implementer'
  key: string;                // "o"+type+id
}

// A mission groups threads + outcomes (factory: mission(name,summary,threads,outcomes,queued)).
export interface Mission {
  name: string;               // "Auth refactor"
  summary: string;            // "2 live · 1 done"
  threads: AgentThread[];
  queued: AgentThread[];      // workers accepted but not yet launched (status==='queued')
  outcomes: Outcome[];
  hasOutcomes: boolean;
  key: string;                // === name
}

// A conversation message (factory: m(kind,who,text,time,i)).
export interface StreamMessage {
  kind: MessageKind;
  who: string | null;         // "You" | "Overseer" | null (notes)
  text: string;
  time: string;               // "9:02" | "now" | ""
  key: string;                // "s"+i / "sx"+n / "sd0"
  isUser: boolean;
  isOverseer: boolean;
  isNote: boolean;
  // image (kind 'image') — a picture posted into the coordinator stream: an image an
  // agent/tool emitted, or one the coordinator posts via the `post_image` MCP tool.
  // These mirror the source 'image' ConvItem (see live.convItemsToStream); `imageUrl` is
  // already a renderable src (data-URI or byte-route URL). Optional so the m() factory and
  // every existing StreamMessage stay valid without change.
  isImage?: boolean;
  imageUrl?: string;
  imageAlt?: string;
  // error (transient) — a failed-to-send notice surfaced inline so a swallowed send
  // failure is VISIBLE (mirrors the agent chat's red "Failed to send message" footer).
  // Optional so the m() factory and every existing StreamMessage stay valid without change.
  isError?: boolean;
}

// An action button on a need card (factory: btn(label, primary)).
export interface NeedAction {
  label: string;
  bg: string;                 // primary→var(--acc), else var(--pane)
  fg: string;                 // primary→#06140B,   else var(--ts)
  bd: string;                 // primary→1px solid var(--acc), else 1px solid var(--border)
}

// An escalation in the Needs-you zone (literal objects in buildScenario('needs')).
export interface Need {
  id: string;                 // 'conflict' | 'approval' | 'question' (also the resolve key)
  icon: string;               // header phosphor class
  title: string;
  framing: string;            // one-paragraph framing of the decision
  isConflict?: boolean;
  isApproval?: boolean;
  isQuestion?: boolean;
  // conflict only — two side-by-side positions:
  aIcon?: string; aLabel?: string; aText?: string;   // approved plan (accent)
  bIcon?: string; bLabel?: string; bText?: string;   // your conflicting note (yellow, italic)
  // approval only:
  cmds?: string[];            // mono command chips
  actions: NeedAction[];      // 2–3 buttons; first is primary
}

export interface Ribbon {
  working: number;
  done: number;
  needs: number;              // = visible (unresolved) needs count
  hasNeeds: boolean;
}

// Drill-in activity step (built in detail()).
export interface DrillStep {
  key: string;                // "st"+i
  text: string;
  icon: string;               // done→'ph-check', now→'ph-circle-notch', next→'ph-circle'
  color: string;              // next→var(--tt), else var(--acc)
  textColor: string;          // next→var(--tt), now→var(--tp), done→var(--ts)
  anim: string;               // now→"spin 1.4s linear infinite", else "none"
  isNow: boolean;
}

// Full drill-in detail (detail(key, missions)).
export interface ThreadDetail {
  typeIcon: string;
  typeLabel: string;
  id: number;
  statusLabel: string;
  dotColor: string;
  dotAnim: string;
  mission: string;            // owning mission name
  elapsed: string;
  action: string;             // current action (also shown in CurrentActionChip)
  steps: DrillStep[];
  surface: string;            // "When tests pass I'll bring you the PR to review — not before."
}

// ---- view-level state contract (foundation additions) ----

// The five scenario conditions (in production these become real data conditions,
// not a harness switcher — see spec §4).
export type Scenario = 'empty' | 'idle' | 'active' | 'needs' | 'drill';

// The fully-derived render values consumed by every component via useRenderVals().
export interface RenderVals {
  ribbon: Ribbon;
  needs: Need[];
  missions: Mission[];
  stream: StreamMessage[];
  busy: boolean;              // coordinator turn in flight → show the WorkingIndicator
  drillDetail: ThreadDetail | null;
  hasNeeds: boolean;
  noMissions: boolean;
  emptyMode: boolean;
  drillOpen: boolean;
  overviewOpen: boolean;
}
