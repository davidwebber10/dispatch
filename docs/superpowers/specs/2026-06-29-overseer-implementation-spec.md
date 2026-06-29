# Overseer View — React Implementation Spec

> Source design: `Overseer.dc.html` (Claude Design "Design Code" artifact). This spec is a
> precise, value-exact translation of that artifact into a buildable React feature for the
> Dispatch web client (`packages/web`, React 18 + TS + `@phosphor-icons/react` + Tailwind v4 +
> zustand). It captures layout, regions, components, states, the mock-data contract, exact
> styling, copy, icons, and interactions.
>
> **The Overseer is a "mission control / chief-of-staff" management surface, NOT a terminal.**
> The user is a *manager, not an operator*: a single coordinator ("Overseer") on the left you
> converse with, the delegated work on the right, and a narrow band at the top reserved for the
> few things only the human can resolve. Implementation churn never reaches the conversation.

---

## 0. What is in the design vs. what to build

The artifact contains two layers:

1. **Prototype harness** (DO NOT BUILD — it only exists to demo the concept):
   - The top 46px toolbar: brand + "concept" badge, a **scenario switcher** segmented control
     (First run / Calm / Several running / Needs you / Drilled in), a **Desktop/Mobile device
     toggle**, and a **Design notes** button that opens a rationale drawer.
   - The "phone frame" chrome around the mobile mockup (rounded 32px shell, fake status bar with
     `10:12` + signal/wifi/battery).
   - The Design notes slide-in drawer (`notesOpen`).
   These map to the JS `scenario`/`device`/`notesOpen` state and exist only to flip between the
   real app's states. In production, `scenario` becomes real data, `device` becomes a responsive
   breakpoint, and the notes drawer is dropped.

2. **The actual Overseer view** (BUILD THIS): the desktop two-region app and its mobile
   three-tab equivalent, plus the Delegate modal. Everything below documents this layer.

---

## 1. Overall layout

### 1a. Design tokens (root CSS custom properties)

Set on the view root (the artifact sets them inline on the root `<div>`). Recommend defining as
CSS variables on a wrapping element or mapping to the existing Dispatch theme.

```
--canvas:  #08080A   /* app backdrop behind the panel */
--base:    #0F0F11   /* main app surface (left column, composer, footers) */
--pane:    #141416   /* right rail surface, headers, chips' inner boxes */
--elev:    #1B1B1E   /* raised cards / chips / inputs */
--hover:   #26262B   /* thread chip hover bg */
--border:  #29292E   /* hairline borders, dividers, progress track */
--acc:     #3ECF6A   /* green accent: Overseer, working, primary actions */
--accDim:  rgba(62,207,106,.12)   /* accent tint backgrounds */
--accLine: rgba(62,207,106,.4)    /* accent borders */
--yellow:  #F5C542   /* "needs you" / waiting / escalation */
--yellowDim: rgba(245,197,66,.1)
--yellowLine: rgba(245,197,66,.35)
--red:     #F0616D   /* interrupt / error */
--tp:      #E9E9EC   /* text primary */
--ts:      #8E8E96   /* text secondary */
--tt:      #5A5A61   /* text tertiary / placeholders */
--mono:    'JetBrains Mono', monospace
--pulse:   2.4s      /* breathe animation duration; 0s when motion disabled */
```

Root element styles: `background:#08080A; color:#E9E9EC; font-family:'IBM Plex Sans',sans-serif;
font-size:13px;` Fonts loaded: **IBM Plex Sans** (400;500;600;700) + **JetBrains Mono**
(400;500;600). Icons: **@phosphor-icons/web 2.1.1** regular/bold/fill (in React, use
`@phosphor-icons/react` — already a dependency).

Global CSS from `<helmet>`:
```css
*{box-sizing:border-box;}
::selection{background:rgba(62,207,106,.25);}
::-webkit-scrollbar{width:9px;height:9px;}
::-webkit-scrollbar-thumb{background:#26262B;border-radius:7px;border:2px solid transparent;background-clip:content-box;}
::-webkit-scrollbar-track{background:transparent;}
textarea::placeholder,input::placeholder{color:#5A5A61;}
```

### 1b. Desktop layout

Outer panel: centered, `max-width:1320px`, `flex` column, `background:var(--base)`,
`border:1px solid var(--border)`, `border-radius:14px`, `overflow:hidden`,
`box-shadow:0 24px 70px -28px rgba(0,0,0,.8)`. (In production this panel can fill the Dispatch
tab content area; the rounded-card framing is optional chrome.)

Structure: **header (54px fixed)** over a **body (flex row, fills remaining height)**. The body
is two regions: a fluid **left conversation column** and a **fixed 380px right rail**.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ HEADER 54px                                                                │
│ [◉ Overseer / moodText]  📁 dispatch        [⚠ N need you][● N working]    │
│                                              [✓ N done today] | ● Connected ⚙ │
├───────────────────────────────────────────────┬──────────────────────────┤
│ LEFT: conversation membrane (flex:1)           │ RIGHT RAIL  380px fixed   │
│                                                │ (overview OR drill)       │
│ ┌─ NEEDS ZONE (hero) — only if hasNeeds ─────┐ │ ┌ Ongoing work  [+Delegate]│
│ │ ⚠ NEEDS YOU · N held · everything handled  │ │ │                          │
│ │ ┌ need card (conflict) ──────────────────┐ │ │ │ ● Auth refactor  2 live·…│
│ │ │ title            raised by Overseer     │ │ │ │ ┌ [icon] implementer ·#4 ●│
│ │ │ framing…                                │ │ │ │ │  action…       ▓▓▓░ 12m │
│ │ │ [Approved plan] ⇆ [Your note]           │ │ │ │ └─────────────────────── │
│ │ │ [Keep the plan][Switch…][Open #4]       │ │ │ │ ┌ reviewer ·#2 …          │
│ │ └────────────────────────────────────────┘ │ │ │ └ (dashed) ✓ outcome card │
│ │ ┌ need card (approval) … ┐ ┌ (question) …┐ │ │ │                          │
│ │ └────────────────────────┘ └────────────┘ │ │ │ ● Mobile crash triage    │
│ └────────────────────────────────────────────┘ │ │   …                      │
│  (needs zone: flex:none, max-height 62%, scroll)│ │  (scrolls)               │
│                                                │ │                          │
│ STREAM (flex:1, scroll)                        │ │                          │
│   ◉ Overseer  9:14   message…                  │ │                          │
│                       9:31  You  message… ▭     │ │                          │
│   ↳ note pill (centered)                        │ │                          │
│                                                │ │                          │
│ COMPOSER (fixed)                               │ │                          │
│ [＋][ Fire a directive to the Overseer…   ][➤] │ │                          │
│  ● Always listening…                    ⌘↵ send│ │                          │
└───────────────────────────────────────────────┴──────────────────────────┘
```

When a thread is drilled into, the **right rail swaps its entire content** from "Ongoing work"
overview to a "Thread detail" view (same 380px column; `overviewOpen = !drill`,
`drillOpen = !!drill`). The left column is unchanged (the conversation keeps flowing); a co-
driving "note" message is appended to the stream.

Body row CSS: left `flex:1; min-width:0; display:flex; flex-direction:column;`. Right rail
`width:380px; flex:none; border-left:1px solid var(--border); background:var(--pane);
display:flex; flex-direction:column; min-height:0;`.

### 1c. Mobile / responsive layout

The mobile mock is a `392px` wide, `max-height:830px` rounded shell. In production this is the
narrow-viewport breakpoint (drop the phone chrome + status bar). It **collapses the two desktop
regions into three tabs** because there's no room for side-by-side.

```
┌─────────────────────────┐
│ HEADER  ◉ Overseer  ● N  │
├─────────────────────────┤
│ [⚠ Needs you ⑶][Stream][Work] │   ← 3-tab segmented control
├─────────────────────────┤
│                         │
│   active tab body       │   NEEDS → stacked need cards (no side-by-side; panels stack)
│   (scrolls)             │   STREAM → messages + composer pinned at bottom
│                         │   WORK   → [Delegate a task] + missions/threads/outcomes
│                         │
└─────────────────────────┘
  Drill-in = full-screen overlay (absolute, inset 30px 0 0 0, z-index 5) over the tabs:
  back · header · co-driving banner · activity timeline · action chip · redirect input.
```

Tab state: `mobileTab ∈ {'needs','stream','work'}`. Active tab `bg:var(--elev)`; the Needs tab's
active text is `var(--yellow)` (others `var(--tp)`); Needs tab shows a yellow count badge when
`hasNeeds`. Differences vs desktop: conflict card lays its two panels **vertically stacked** (no
`⇆` arrow); need card header omits the "raised by Overseer" tag; the drill overlay omits the
Interrupt / "Open raw terminal" controls row.

What collapses on mobile: the persistent right rail becomes the **Work** tab; the hero Needs
zone becomes the **Needs** tab; the conversation becomes the **Stream** tab. The header "N
working" chip stays; the ribbon's other counts and "Connected"/gear are dropped.

---

## 2. Content regions (mapping design → product concept)

| Region | Product role | Desktop location | Mobile location |
|---|---|---|---|
| **Status ribbon** | One-line triage answer: `N need you · N working · N done`. Only "need you" is colored + clickable. | Header right cluster | Header (just "N working" chip) |
| **Needs-you zone** | Decisions & approvals queue — the "needs you" escalations, the hero. Conflict / approval / question cards, each self-contained. Not rendered when empty. | Top of left column (above stream) | "Needs you" tab |
| **Conversation stream** | The durable directive log / intent spine — two-way dialogue with the Overseer. Escalations rise *into* it as the Overseer "raising" something is part of the dialogue. | Left column middle | "Stream" tab |
| **Composer** | "Always listening" directive input; instant capture, never blocked by work. ⌘↵ to send. | Left column bottom | "Stream" tab bottom |
| **Ongoing work rail** | Missions + their ephemeral typed agent threads (status). Peripheral, glanceable, never demanding. | Right rail (overview) | "Work" tab |
| **Mission group** | Groups threads + collapsed outcomes under a named initiative with a `live·held·done` summary. | Right rail | "Work" tab |
| **Agent thread chip** | One ephemeral typed agent: type + one-line current action + living dot + progress + elapsed. Click to drill in. | Right rail / Work tab | same |
| **Outcome card** | Finished thread, collapsed to a compact dashed muted record (summary + PR/diff link). Self-pruning. | Right rail / Work tab | same |
| **Thread detail (drill-in)** | Drilled-into thread: structured activity timeline (never a terminal), redirect input, interrupt, opt-in raw-terminal link. | Right rail (swaps overview) | full-screen overlay |
| **Delegate modal** | Spawn/delegate a subtask: describe → Overseer proposes a typed agent → confirm. | Centered modal | Centered modal |

---

## 3. Component inventory

Proposed React component tree (names are recommendations). Region in brackets.

```
<OverseerView>                         // root; owns state/store; applies theme tokens
├─ <OverseerHeader>                    // [header] brand + mood + status ribbon
│  ├─ <BrandBadge>                     //   gradient logo + "Overseer" + moodText + "dispatch" chip
│  └─ <StatusRibbon>                   //   "N need you" (yellow,clickable) · "N working" · "N done today" · Connected · gear
├─ <OverseerBody>                      // [body] flex row
│  ├─ <ConversationColumn>             // [left] flex column
│  │  ├─ <NeedsZone>                   //   [needs] hero queue; only if hasNeeds
│  │  │  ├─ <NeedsZoneHeader>          //     "NEEDS YOU · N held · everything else is handled"
│  │  │  └─ <NeedCard> × N             //     one per need
│  │  │     ├─ <ConflictPanels>        //       if isConflict: two side-by-side context panels + ⇆
│  │  │     ├─ <ApprovalCommands>      //       if isApproval: mono command chips
│  │  │     └─ <NeedActions>           //       action buttons (btn())
│  │  ├─ <ConversationStream>          //   [stream] scrollable message list
│  │  │  └─ <StreamMessage>            //     renders OverseerMessage | UserMessage | NoteMessage
│  │  └─ <Composer>                    //   [composer] + textarea + send; "always listening" hint
│  └─ <WorkRail>                       // [right] 380px; renders Overview OR Detail
│     ├─ <OngoingWorkOverview>         //   if !drill
│     │  ├─ <RailHeader>               //     "Ongoing work" + Delegate button
│     │  ├─ <MissionGroup> × N         //     mission header + threads + outcomes
│     │  │  ├─ <AgentThreadChip> × N   //       clickable; drill in
│     │  │  └─ <OutcomeCard> × N       //       dashed collapsed record
│     │  └─ <EmptyMissions>            //     if noMissions
│     └─ <ThreadDetail>               //   if drill
│        ├─ <ThreadDetailHeader>       //     back + type + status·elapsed
│        ├─ <CoDrivingBanner>          //     "You're steering this thread…"
│        ├─ <ActivityTimeline>         //     <ActivityStep> × N (done/now/next)
│        ├─ <CurrentActionChip>        //     pencil + detail.action
│        ├─ <SurfaceNote>              //     "When tests pass I'll bring you the PR…"
│        └─ <ThreadDetailFooter>       //     redirect input + Interrupt + raw-terminal link
├─ <DelegateModal>                     // [modal] if delegateOpen
│  ├─ textarea + recommendation line
│  ├─ <AgentTypePicker>                //   planner/implementer/researcher/reviewer chips
│  └─ footer Cancel / Delegate
└─ (mobile) <OverseerMobile>           // breakpoint variant: header + <MobileTabs> + tab bodies + <MobileDrillOverlay>
```

Shared atoms worth extracting: `<StatusDot color anim>` (6px circle, optional `breathe`),
`<TypeIconBox>` (rounded square with the agent-type phosphor icon), `<ProgressBar width>`,
`<MonoLabel>` (uppercase mono tracking label), `<PillButton>` (the `btn()` styled buttons).

### Component data needs (props)

- `StatusRibbon`: `{ working, done, needs, hasNeeds }` + `onNeedsClick`.
- `NeedCard`: a `Need` (see §5) + `onAction(needId, label)`.
- `StreamMessage`: a `StreamMessage`.
- `Composer`: `{ value, onChange, onKeyDown, onSend, onDelegate }`.
- `MissionGroup`: a `Mission` + `onDrill(threadKey, dlabel)`.
- `AgentThreadChip`: an `AgentThread` + `onClick`.
- `OutcomeCard`: an `Outcome`.
- `ThreadDetail`: a `ThreadDetail` + `onClose`, `onRedirect`, `onInterrupt`.
- `DelegateModal`: `{ open, text, type, recommend, typeDefs, onText, onPickType, onConfirm, onClose }`.

---

## 4. States

All driven by JS state `{ scenario, device, drill, mobileTab, notesOpen, delegateOpen,
delegateType, delegateText, composer, extra[], resolved[], spawned[] }`. The five **scenarios**
(harness switcher → real data conditions in production):

| Scenario | Trigger | Ribbon | Missions | Needs | Stream | moodText | Visual |
|---|---|---|---|---|---|---|---|
| `empty` (**First run**) | `setScenario('empty')` | working 0, done 0 | none | none | 1 Overseer greeting | "Ready when you are" | No needs zone; rail shows `<EmptyMissions>` empty state + "Delegate a task" CTA |
| `idle` (**Calm**) | `setScenario('idle')` | working 2, done 1 | 2 (Auth refactor, Mobile crash triage) | none | 5 msgs | "Calm — nothing needs you" | No needs zone; no yellow; quiet rail |
| `active` (**Several running**) | `setScenario('active')` | working 4, done 3 | 4 (`baseMissions()`) | none | 4 msgs | "Calm — nothing needs you" | More chips, still no yellow |
| `needs` (**Needs you**) — *default* | `setScenario('needs')` | working 2, done 3 | 4 base, but 2 threads flipped to `waiting` | 3 (conflict, approval, question) | 4 msgs + 1 appended Overseer msg | "N things need you" | Needs zone hero appears; ribbon "N need you" yellow chip; mission summaries show "held" |
| `drill` (**Drilled in**) | `setScenario('drill')` | (as `active`) | as `active` | none | adds a `note` co-driving message | — | Right rail swaps overview → `<ThreadDetail>` for `implementer #4`; mobile jumps to Work tab |

State derivations in `renderVals()`:
- `needs = data.needs.filter(n => !resolved.includes(n.id))` — approving/denying a need removes
  its card live.
- `missions`: cloned; if `spawned.length`, the spawned threads are **prepended to
  `missions[0].threads`**; every thread gets `dlabel = "<typeLabel> #<id> · <missionName>"`.
- `stream = [...data.stream, ...extra]` — `extra` accumulates user sends, Overseer canned
  replies, need-resolution acks, delegate acks, drill notes.
- `moodText`: `>0 needs` → `"N thing(s) needs/need you"`; else `empty` → `"Ready when you are"`,
  otherwise `"Calm — nothing needs you"`.
- `activeId = drill ? 'drill' : scenario` (harness highlight only).
- `drillOpen = !!drill`, `overviewOpen = !drill`, `noMissions = missions.length === 0`,
  `emptyMode = scenario === 'empty'`.

Additional UI states: **Delegate modal open** (`delegateOpen`), **Design notes open**
(`notesOpen`, harness only), **composer non-empty**, **mobile tab selection**.

### Theme props (`data-props`) — exposed tweaks

```
accent  : color enum, default #3ECF6A  (options: #3ECF6A, #C7F03C, #5B9DFF, #F5C542)  → sets --acc/--accDim/--accLine
density : 'comfortable' | 'compact'     (compact → root font-size 12px, else 13px)
motion  : boolean, default true          (false → --pulse '0s', i.e. animations off)
```
`applyTheme()` writes these to the root element on mount/update. Recommend exposing the same
three as view settings in production.

---

## 5. Mock data model (TypeScript contract)

This is the exact data contract the real implementation must populate. Derived from the `th()`,
`outc()`, `mission()`, `m()`, `btn()` factories, the `build()` scenarios, and `detail()`.

```ts
export type AgentType = 'planner' | 'implementer' | 'researcher' | 'reviewer';
export type ThreadStatus = 'working' | 'waiting' | 'done' | 'error';
export type MessageKind = 'user' | 'overseer' | 'note';

// TYPE registry — phosphor class + display label per agent type
export const AGENT_TYPE = {
  planner:     { icon: 'ph-compass',          label: 'planner' },
  implementer: { icon: 'ph-code',             label: 'implementer' },
  researcher:  { icon: 'ph-magnifying-glass', label: 'researcher' },
  reviewer:    { icon: 'ph-seal-check',       label: 'reviewer' },
} as const;

// STATUS registry — dot color + label per status
export const STATUS = {
  working: { color: 'var(--acc)',    label: 'working' },
  waiting: { color: 'var(--yellow)', label: 'waiting on you' },
  done:    { color: 'var(--ts)',     label: 'done' },
  error:   { color: 'var(--red)',    label: 'error' },
} as const;

// An ephemeral typed agent thread (factory: th(type,id,action,status,elapsed,progress))
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
  isWorking: boolean; isWaiting: boolean; isDone: boolean;
  dotAnim: string;            // "breathe var(--pulse) ease-in-out infinite" | "none"
  progressW: string;          // "62%"
  showProgress: boolean;      // true only when status==='working'
  metaRight: string;          // working→elapsed, waiting→"held "+elapsed, else elapsed
  key: string;                // type+id, e.g. "implementer4"
  dlabel?: string;            // added later: "implementer #4 · Auth refactor"
}

// A finished thread, collapsed (factory: outc(type,id,title,meta))
export interface Outcome {
  type: AgentType;
  id: number;
  title: string;              // "Patched null-deref in MapView"
  meta: string;               // "PR #218 · +24 −6"  /  "locked in · 8m ago"
  typeLabel: string;          // 'implementer'
  key: string;                // "o"+type+id
}

// A mission groups threads + outcomes (factory: mission(name,summary,threads,outcomes))
export interface Mission {
  name: string;               // "Auth refactor"
  summary: string;            // "2 live · 1 done"
  threads: AgentThread[];
  outcomes: Outcome[];
  hasOutcomes: boolean;
  key: string;                // === name
}

// A conversation message (factory: m(kind,who,text,time,i))
export interface StreamMessage {
  kind: MessageKind;
  who: string | null;         // "You" | "Overseer" | null (notes)
  text: string;
  time: string;               // "9:02" | "now" | ""
  key: string;                // "s"+i or "x"+n or "d0"
  isUser: boolean; isOverseer: boolean; isNote: boolean;
}

// An action button on a need card (factory: btn(label, primary))
export interface NeedAction {
  label: string;
  bg: string;                 // primary→var(--acc), else var(--pane)
  fg: string;                 // primary→#06140B,   else var(--ts)
  bd: string;                 // primary→1px solid var(--acc), else 1px solid var(--border)
}

// An escalation in the Needs-you zone (literal objects in build('needs'))
export interface Need {
  id: string;                 // 'conflict' | 'approval' | 'question' (also used as resolve key)
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
  moodText: string;
}

// Drill-in activity step (built in detail())
export interface DrillStep {
  key: string;                // "st"+i
  text: string;
  icon: string;               // done→'ph-check', now→'ph-circle-notch', next→'ph-circle'
  color: string;              // next→var(--tt), else var(--acc)
  textColor: string;          // next→var(--tt), now→var(--tp), done→var(--ts)
  anim: string;               // now→"spin 1.4s linear infinite", else "none"
  isNow: boolean;
}

// Full drill-in detail (detail(key, missions))
export interface ThreadDetail {
  typeIcon: string; typeLabel: string; id: number;
  statusLabel: string; dotColor: string; dotAnim: string;
  mission: string;            // owning mission name
  elapsed: string;
  action: string;             // current action (also shown in CurrentActionChip)
  steps: DrillStep[];
  surface: string;            // "When tests pass I'll bring you the PR to review — not before."
}
```

### Sample values (verbatim from the artifact)

`baseMissions()` (the `active`/`needs` scenarios):
```ts
[
  mission('Auth refactor', '2 live · 1 done', [
    th('implementer', 4, 'Writing the JWT verify middleware', 'working', '12m', 62),
    th('reviewer', 2, 'Auditing the token-rotation approach', 'working', '3m', 40),
  ], [
    outc('planner', 1, 'Plan approved — cookie sessions, server-side rotation', 'locked in · 8m ago'),
  ]),
  mission('Mobile crash triage', '1 live · 1 done', [
    th('researcher', 7, 'Bisecting the iOS 18 crash', 'working', '6m', 30),
  ], [
    outc('implementer', 5, 'Patched null-deref in MapView', 'PR #218 · +24 −6'),
  ]),
  mission('Search relevance', '1 live', [
    th('implementer', 9, 'Reindexing with BM25 weights', 'working', '22m', 78),
  ], []),
  mission('Docs cleanup', '1 done', [], [
    outc('reviewer', 3, 'Merged — API reference fixes', 'PR #214 · +112 −80'),
  ]),
]
```

The three `needs` (escalation cards):
```ts
[
  { id:'conflict', isConflict:true, icon:'ph-arrows-merge',
    title:'Direction conflict — Auth refactor',
    framing:'Two minutes ago you told implementer #4 to "just stash the token in localStorage." '
          + "The reviewer-approved plan calls for httpOnly cookies only. Both can't hold — here are the two sides.",
    aIcon:'ph-seal-check', aLabel:'Approved plan',
    aText:'httpOnly cookies, refresh rotation server-side. Tokens never reachable from JS — hardened against XSS.',
    bIcon:'ph-user', bLabel:'Your note to #4 · 2m ago',
    bText:'"just stash the token in localStorage so the SPA can read it directly"',
    actions:[btn('Keep the plan', true), btn('Switch to localStorage'), btn('Open #4 to decide')] },

  { id:'approval', isApproval:true, icon:'ph-shield-check',
    title:'Permission — implementer #4',
    framing:'To wire the new middleware, #4 needs to run:',
    cmds:['pnpm add jose', 'edit .github/workflows/ci.yml'],
    actions:[btn('Approve', true), btn('Deny'), btn('Always allow · this mission')] },

  { id:'question', isQuestion:true, icon:'ph-chat-teardrop-text',
    title:'Question — researcher #7',
    framing:'Reproduce on iOS 16 too, or 17+ only? It changes the device matrix and roughly doubles the run.',
    actions:[btn('17+ only', true), btn('Include 16'), btn('You choose')] },
]
```
In the `needs` scenario, `missions[0].threads[0]` and `missions[1].threads[0]` are overridden to
`waiting`:
```ts
missions[0].threads[0] = th('implementer', 4, 'Paused — awaiting your call on token storage', 'waiting', '2m', 62);
missions[0].summary = '1 live · 1 held · 1 done';
missions[1].threads[0] = th('researcher', 7, 'Paused — needs the device-matrix answer', 'waiting', '5m', 30);
missions[1].summary = '1 held · 1 done';
```

Drill activity timelines by type (`detail()`), e.g. implementer:
```ts
[ {s:'done',t:'Read auth/session.ts and middleware/*'},
  {s:'done',t:'Drafted JWT verify middleware'},
  {s:'done',t:'Wired refresh-token rotation'},
  {s:'now', t:'Running auth test suite — 5 / 8 passing'},
  {s:'next',t:'Update CHANGELOG, open PR for review'} ]
```
(researcher / reviewer / planner have their own 3–4 step lists — see §7.) `detail().surface`
is always `"When tests pass I'll bring you the PR to review — not before."`

---

## 6. Exact styling per component

> Spacing/size values are literal from the artifact. Borders are `1px solid var(--border)`
> unless noted. All fonts IBM Plex Sans unless `var(--mono)` (JetBrains Mono) is specified.

### Header (desktop, 54px)
- Bar: `height:54px; background:var(--pane); border-bottom:1px solid var(--border);
  display:flex; align-items:center; gap:16px; padding:0 18px;`
- Logo: `26×26; border-radius:7px; background:linear-gradient(150deg,#1b3a26,#0f1f16);
  border:1px solid var(--accLine); color:var(--acc); font-size:14px;` icon `ph-fill ph-broadcast`.
- Title block: "Overseer" `13.5px/600`; subline `ribbon.moodText` `10.5px var(--tt)`; line-height 1.15.
- "dispatch" chip: mono `11px var(--tt)`, `ph-folder-simple`, `margin-left:6px`.
- "N need you" button (if hasNeeds): `padding:5px 11px; border-radius:8px;
  background:var(--yellowDim); border:1px solid var(--yellowLine); color:var(--yellow);
  font-size:12px/600;` icon `ph-fill ph-warning`. → `goNeeds`.
- "N working" chip: `padding:5px 10px; border-radius:8px; background:var(--elev);
  border:1px solid var(--border); font-size:12px; color:var(--ts);` + 6px acc dot with
  `animation:breathe var(--pulse) ease-in-out infinite`.
- "N done today" chip: `padding:5px 10px; border-radius:8px; font-size:12px; color:var(--tt);`
  icon `ph-check-circle` (no bg).
- Divider: `1px × 22px var(--border)`.
- "Connected": 6px acc dot (static) + `11.5px var(--ts)`. Gear: `ph-gear 16px var(--tt)`.

### Needs zone (desktop hero)
- Container: `flex:none; max-height:62%; overflow-y:auto; border-bottom:1px solid var(--border);
  background:linear-gradient(180deg,rgba(245,197,66,.045),transparent 60%);
  padding:15px 22px 18px;`
- Header row (gap 9, margin-bottom 12): `ph-fill ph-warning` yellow 15px; "Needs you" mono
  `10.5px` uppercase letter-spacing `.09em` yellow; "{needs} held · everything else is handled"
  mono `10.5px var(--tt)`.
- Cards: column `gap:11px`. Card: `border:1px solid var(--border); border-radius:11px;
  background:var(--elev); overflow:hidden;`
  - Card header: `padding:11px 13px; border-bottom:1px solid var(--border);` →
    `ph-fill {n.icon}` yellow 16px; title `13px/600 var(--tp)`; spacer; "raised by Overseer"
    (`ph-broadcast` mono `9.5px var(--tt)`).
  - Card body: `padding:12px 13px;`
    - framing: `12.5px/1.55 var(--ts); margin-bottom:12px;`
    - **Conflict** (`flex; gap:10px; margin-bottom:13px;`): left panel `flex:1; border;
      border-radius:8px; padding:10px 11px; background:var(--pane);` header (`ph-fill {aIcon}`
      acc 13px + aLabel mono `9.5px` uppercase `.06em` var(--ts)) + aText `12px/1.5 var(--tp)`.
      Center: `ph-bold ph-arrows-left-right var(--tt) 14px; align-self:center;`. Right panel same
      but `border:1px solid var(--yellowLine)`, `ph-fill {bIcon}` yellow, bText
      `12px/1.5 var(--tp); font-style:italic;`.
    - **Approval** (`flex column; gap:6px; margin-bottom:13px;`): each cmd chip `inline-flex;
      gap:8px; font-family:mono; font-size:11.5px; color:var(--tp); background:var(--pane);
      border; border-radius:7px; padding:7px 10px;` with `ph-terminal-window var(--tt)`.
    - Actions row: `flex; gap:8px; flex-wrap:wrap;`. Button: `padding:7px 13px;
      border-radius:8px; background:{a.bg}; color:{a.fg}; border:{a.bd}; font-size:12px/600;`
      data-need / data-label / onClick `onNeedAction`.

### Conversation stream
- Container: `flex:1; min-height:0; overflow-y:auto; padding:20px 22px; display:flex;
  flex-direction:column; gap:17px;`
- **Overseer** msg: row `gap:11px`. Avatar `24×24; border-radius:7px;
  background:linear-gradient(150deg,#1b3a26,#0f1f16); border:1px solid var(--accLine);
  color:var(--acc); font-size:12px;` `ph-fill ph-broadcast`. Header: "Overseer" `11.5px/600
  var(--acc)` + time mono `10px var(--tt)`. Body `13.5px/1.55 var(--tp); max-width:64ch;`.
- **User** msg: `justify-content:flex-end; max-width:72%;`. Header (right): time mono `10px
  var(--tt)` + "You" `11.5px/600 var(--ts)`. Bubble: `background:var(--elev); border;
  border-radius:11px; border-top-right-radius:3px; padding:9px 13px; 13.5px/1.55 var(--tp);`.
- **Note** msg: `justify-content:center;`. Pill: `inline-flex; gap:7px; padding:5px 12px;
  border-radius:20px; background:var(--accDim); border:1px solid var(--accLine); 11.5px
  var(--ts); max-width:80%;` `ph-arrow-bend-down-right var(--acc)`.

### Composer
- Container: `flex:none; border-top; padding:12px 16px 13px; background:var(--base);`
- Input row: `flex; align-items:flex-end; gap:8px; background:var(--elev); border;
  border-radius:12px; padding:7px 8px 7px 9px;`
  - "+" button: `31×31; border-radius:8px; background:var(--pane); border; color:var(--ts);
    font-size:17px;` `ph-plus`, title "Delegate as a task". → openDelegate.
  - textarea: `flex:1; background:transparent; border:none; outline:none; resize:none;
    color:var(--tp); font-size:13.5px; line-height:1.5; max-height:120px; padding:7px 2px;`
    rows 1, placeholder "Fire a directive to the Overseer…".
  - send button: `32×32; border-radius:8px; background:var(--acc); color:#06140B;
    font-size:16px;` `ph-fill ph-paper-plane-right`. → onSend.
- Hint row (`margin-top:8px`): breathing 6px acc dot + "Always listening — capture is instant,
  never blocked by the work below" `10.5px var(--tt)`; spacer; "⌘↵ send" mono `10px var(--tt)`.

### Work rail — overview
- Rail header: `padding:13px 16px; border-bottom;` → "Ongoing work" mono `10.5px` uppercase
  `.09em` var(--tt); spacer; "Delegate" button `padding:6px 11px; border-radius:8px;
  background:var(--acc); color:#06140B; font-size:12px/600;` `ph-bold ph-plus`.
- Scroll body: `padding:15px 16px; display:flex; flex-direction:column; gap:18px;`
- Mission header: `padding:0 2px;` → 5px var(--ts) dot; name `13px/600 var(--tp)`; spacer;
  summary mono `10px var(--tt)`.
- **Agent thread chip**: `display:flex; gap:10px; padding:11px 12px; background:var(--elev);
  border; border-radius:9px; cursor:pointer;` hover → `background:var(--hover);
  border-color:#36363c;`. data-key / data-label / onClick `onDrill`.
  - Type icon box: `28×28; border-radius:7px; background:var(--pane); border; color:var(--ts);
    font-size:15px;` `ph {typeIcon}`.
  - Body (`gap:5px`): row1 = "{typeLabel} · #{id}" mono `10.5px var(--ts)`, spacer, status =
    `{dotColor}` 6px dot `animation:{dotAnim}` + statusLabel `10.5px var(--ts)`. row2 = action
    `13px var(--tp)` (ellipsis, nowrap). row3 (if working) = progress bar (`flex:1; height:3px;
    border-radius:3px; background:var(--border);` fill `width:{progressW}; background:var(--acc);`)
    + elapsed mono `10px var(--tt)`.
- **Outcome card**: `display:flex; gap:10px; padding:9px 12px; border:1px dashed var(--border);
  border-radius:9px;` → 24×24 `ph-fill ph-seal-check var(--acc) 15px`; title `12.5px var(--ts)`;
  "{typeLabel} #{id} · {meta}" mono `9.5px var(--tt)`; `ph-arrow-up-right var(--tt) 13px`.
- **Empty missions**: centered, `margin-top:24px;` → 46×46 box (`border-radius:12px;
  background:var(--elev); border; color:var(--tt); font-size:22px;`) `ph-stack`; text "No
  missions yet.<br>Fire a directive, or delegate your first task." `13px var(--ts)`; "Delegate a
  task" acc button (`ph-bold ph-plus`).

### Work rail — thread detail (drill)
- Header: `padding:12px 14px; border-bottom;` → back button `28×28; border-radius:7px;
  background:var(--elev); border; color:var(--ts); 15px;` `ph-arrow-left` (→ closeDrill);
  type icon box 28×28 (`background:var(--pane)`); "{typeLabel} · #{id}" `13px/600 var(--tp)` +
  mission mono `10px var(--tt)`; status `{dotColor}` dot `{dotAnim}` + "{statusLabel} · {elapsed}"
  `10.5px var(--ts)`.
- Body: `padding:14px 16px;`
  - Co-driving banner: `padding:9px 11px; border:1px solid var(--accLine);
    background:var(--accDim); border-radius:9px; margin-bottom:16px;` `ph-fill ph-steering-wheel
    var(--acc) 15px` + "You're steering this thread — the Overseer is holding everything else."
    `12px var(--tp)`.
  - "Activity" mono `10px` uppercase `.09em` var(--tt).
  - Timeline (`margin:11px 0 16px`): each step row `gap:11px; align-items:flex-start;`. Left
    gutter: `ph {st.icon}` `color:{st.color}; font-size:14px; animation:{st.anim};` then 1px
    vertical connector `flex:1; width:1px; background:var(--border); margin:3px 0;`. Right: text
    `12.5px {st.textColor}; line-height:1.4; padding-bottom:12px;`.
  - Current action chip: `font-family:mono; font-size:11px; color:var(--ts);
    background:var(--elev); border; border-radius:8px; padding:9px 11px; margin-bottom:14px;`
    `ph-pencil-simple var(--acc)` + `detail.action`.
  - Surface note: `12px var(--ts); line-height:1.5;` `ph-broadcast var(--acc)` + `detail.surface`.
- Footer: `border-top; padding:11px 14px; background:var(--base);`
  - Redirect input row: `background:var(--elev); border; border-radius:10px;
    padding:6px 6px 6px 10px;` input placeholder "Redirect #4 — it folds in immediately…"
    `12.5px var(--tp)` + "Send" button `padding:6px 11px; border-radius:7px;
    background:var(--acc); color:#06140B; 11.5px/600`.
  - Controls (`margin-top:9px`): "Interrupt" button `border:1px solid var(--border);
    color:var(--red); background:transparent; padding:5px 10px; border-radius:7px; 11.5px/500;`
    `ph-hand-palm`; spacer; "Open raw terminal" link `11px var(--tt)` + `ph-arrow-up-right`.

### Delegate modal
- Overlay: `position:fixed; inset:0; background:rgba(0,0,0,.6); display:flex; align-items:center;
  justify-content:center; padding:24px; z-index:50;`
- Dialog: `width:480px; background:#18181B; border:1px solid #2F2F35; border-radius:13px;
  box-shadow:0 30px 80px -20px rgba(0,0,0,.85); overflow:hidden;`
- Header: `padding:14px 16px; border-bottom;` `ph-fill ph-paper-plane-right var(--acc) 16px` +
  "Delegate a task" `14px/600`; close X button `26×26` (`ph-x`).
- Body `padding:16px;`: textarea `background:var(--pane); border:1px solid #2C2C32;
  border-radius:9px; 13px/1.5; padding:10px 12px;` rows 3, placeholder "Describe what you want
  done — the Overseer breaks it down…". Recommendation line (`margin:14px 0 9px`): `ph-broadcast
  var(--acc) 13px` + "Overseer suggests a **{recommend}** — switch the type if you'd rather."
  ({recommend} in `var(--acc)/600`). Type chips (`flex; gap:7px; flex-wrap:wrap;`): each
  `padding:8px 12px; border-radius:9px;` selected → `background:var(--accDim); color:var(--acc);
  border:1px solid var(--accLine)`, else `background:var(--pane); color:var(--ts); border:1px
  solid var(--border)`. `ph {icon}` + label. data-type / onClick `pickType`.
- Footer: `padding:13px 16px; border-top; justify-content:flex-end; gap:9px;`. "Cancel"
  (transparent, border, var(--ts)) → closeDelegate; "Delegate →" (`background:var(--acc);
  color:#06140B; 12.5px/600`, `ph-bold ph-arrow-right`) → doDelegate.

### Mobile specifics
- Shell: `width:392px; max-height:830px; border-radius:32px; overflow:hidden;` (drop in prod).
- Status bar: `height:30px; mono 11px var(--ts); background:var(--pane);` "10:12" + `ph-fill
  ph-cell-signal-full / ph-wifi-high / ph-battery-high`.
- Header: `padding:9px 16px; border-bottom; background:var(--pane);` 24×24 logo; "Overseer"
  `13px/600` + moodText `10px var(--tt)`; spacer; working chip (`padding:4px 9px;
  background:var(--elev); border; 11px var(--ts)` + breathing 5px acc dot).
- Tabs: `padding:8px 12px; border-bottom; background:var(--pane); gap:4px;`. Each `flex:1;
  padding:8px 0; border-radius:8px;` active `background:var(--elev)`. Needs tab `ph-fill
  ph-warning` + yellow count badge (`background:var(--yellow); color:#1a1400; border-radius:9px;
  font-size:9.5px/700; padding:1px 6px; font-family:mono;`).
- Mobile drill overlay: `position:absolute; inset:30px 0 0 0; background:var(--base);
  z-index:5;` — same content blocks as desktop drill minus the Interrupt/raw-terminal row.

### Animations (`@keyframes`)
```css
@keyframes breathe { 0%,100%{opacity:1} 50%{opacity:.28} }   /* duration var(--pulse)=2.4s */
@keyframes spin    { to{transform:rotate(360deg)} }
@keyframes slidein { from{opacity:0;transform:translateY(7px)} to{opacity:1;transform:none} }
```
- `breathe` — used on every "working" status dot, the header "N working" dot, and the composer
  "always listening" dot (`animation:breathe var(--pulse) ease-in-out infinite`). Gated by the
  `motion` prop (`--pulse:0s` disables).
- `spin` — used on the drill timeline's "now" step icon (`ph-circle-notch`),
  `animation:spin 1.4s linear infinite`.
- `slidein` — **defined in the helmet but not referenced in the template.** Reserved for new
  stream-message entrance; recommend applying it to appended `extra` messages in production.

---

## 7. Copy (verbatim labels / placeholders / text)

**Header / ribbon:** moodText `"Ready when you are"` (empty) / `"Calm — nothing needs you"` /
`"N thing(s) needs/need you"`; `"N need you"`, `"N working"`, `"N done today"`, `"Connected"`,
`"dispatch"`.

**Needs zone:** `"Needs you"`, `"{N} held · everything else is handled"`, `"raised by Overseer"`,
`"Approved plan"`, `"Your note to #4 · 2m ago"`. Card titles: `"Direction conflict — Auth
refactor"`, `"Permission — implementer #4"`, `"Question — researcher #7"`. Action labels: `"Keep
the plan"`, `"Switch to localStorage"`, `"Open #4 to decide"`, `"Approve"`, `"Deny"`, `"Always
allow · this mission"`, `"17+ only"`, `"Include 16"`, `"You choose"`.

**Composer:** placeholder `"Fire a directive to the Overseer…"` (mobile `"Fire a directive…"`);
`"Always listening — capture is instant, never blocked by the work below"`; `"⌘↵ send"`.

**Work rail:** `"Ongoing work"`, `"Delegate"`, `"Delegate a task"`, empty `"No missions yet."` /
`"Fire a directive, or delegate your first task."` (mobile `"Fire a directive to begin."`).

**Drill:** `"You're steering this thread — the Overseer is holding everything else."` (mobile:
`"…the Overseer holds everything else."`); `"Activity"`; surface `"When tests pass I'll bring you
the PR to review — not before."`; redirect placeholder `"Redirect #4 — it folds in immediately…"`
(mobile `"Redirect #4…"`); `"Send"`, `"Interrupt"`, `"Open raw terminal"`.

**Delegate modal:** `"Delegate a task"`, placeholder `"Describe what you want done — the Overseer
breaks it down…"`, `"Overseer suggests a {type} — switch the type if you'd rather."`, `"Cancel"`,
`"Delegate"`.

**Canned Overseer/system messages (from handlers):**
- Empty greeting: `"I'm your Overseer for this project. Tell me what to move on and I'll open
  missions, spin up the right agents, and only surface what needs your call. I don't write code
  myself — so I'm always free to listen."`
- onSend reply (after 550ms): `"Captured. I'll fold it in and surface anything that needs you —
  keep going."`
- onNeedAction ack: `"\"{label}\" — got it. I'll pass it down and close this out."`
- doDelegate ack: `"Spun up a {type} for \"{text}.\" Tracking it now — I'll bring you the
  outcome."`
- onDrill note: `"You stepped into {dlabel}. I'll keep everything else moving."`
- scenario=drill note: `"You stepped into implementer #4 · Auth refactor. I'll keep everything
  else moving and flag you if anything shifts."`

**Idle/active stream copy** (sample dialogue) is in §5's `build()` — e.g. `"Let's tighten up auth
before the release."`, `"Opened Auth refactor and put a planner on it…"`, etc.

**Drill activity steps** (`detail()`):
- implementer: Read auth/session.ts and middleware/* (done) · Drafted JWT verify middleware
  (done) · Wired refresh-token rotation (done) · Running auth test suite — 5 / 8 passing (now) ·
  Update CHANGELOG, open PR for review (next)
- researcher: Pulled 142 crash reports from the last 7d (done) · Clustered to a single MapView
  null-deref (done) · Bisecting builds to find the regression (now) · Hand a minimal repro to an
  implementer (next)
- reviewer: Read the proposed rotation flow (done) · Checking it against OWASP session guidance
  (now) · Return a verdict + risks to the Overseer (next)
- planner: Surveyed current auth surface (done) · Drafting the migration plan (now) · Hand the
  plan up for your approval (next)

---

## 8. Icons (Phosphor `ph-*` → `@phosphor-icons/react`)

Weight: `ph` → default (regular); `ph-bold` → `weight="bold"`; `ph-fill` → `weight="fill"`.

| ph class | React component | Used for |
|---|---|---|
| `ph-broadcast` | `Broadcast` | Overseer brand / avatar / "raised by Overseer" / surface note |
| `ph-folder-simple` | `FolderSimple` | "dispatch" project chip |
| `ph-warning` | `Warning` | Needs-you / escalation (fill) |
| `ph-check-circle` | `CheckCircle` | "N done today" |
| `ph-gear` | `Gear` | header settings |
| `ph-monitor` | `Monitor` | harness desktop toggle |
| `ph-device-mobile` | `DeviceMobile` | harness mobile toggle |
| `ph-notebook` | `Notebook` | harness design notes |
| `ph-plus` | `Plus` | composer "+", Delegate buttons (bold) |
| `ph-paper-plane-right` | `PaperPlaneRight` | send / delegate modal title (fill) |
| `ph-arrow-bend-down-right` | `ArrowBendDownRight` | note pill |
| `ph-arrows-left-right` | `ArrowsLeftRight` | conflict center divider (bold) |
| `ph-arrows-merge` | `ArrowsMerge` | conflict card header (fill) |
| `ph-shield-check` | `ShieldCheck` | approval/permission card (fill) |
| `ph-chat-teardrop-text` | `ChatTeardropText` | question card (fill) |
| `ph-terminal-window` | `TerminalWindow` | approval command chips |
| `ph-seal-check` | `SealCheck` | reviewer type icon / outcome / conflict "approved plan" (fill) |
| `ph-user` | `User` | conflict "your note" (fill) |
| `ph-compass` | `Compass` | planner type icon |
| `ph-code` | `Code` | implementer type icon |
| `ph-magnifying-glass` | `MagnifyingGlass` | researcher type icon |
| `ph-stack` | `Stack` | empty-missions illustration |
| `ph-arrow-up-right` | `ArrowUpRight` | outcome link / "open raw terminal" |
| `ph-arrow-left` | `ArrowLeft` | drill back |
| `ph-steering-wheel` | `SteeringWheel` | co-driving banner (fill) |
| `ph-pencil-simple` | `PencilSimple` | current-action chip |
| `ph-hand-palm` | `HandPalm` | Interrupt |
| `ph-check` | `Check` | timeline "done" step |
| `ph-circle-notch` | `CircleNotch` | timeline "now" step (spin) |
| `ph-circle` | `Circle` | timeline "next" step |
| `ph-x` | `X` | modal close |
| `ph-arrow-right` | `ArrowRight` | delegate confirm (bold) |
| `ph-cell-signal-full` | `CellSignalFull` | mobile status bar (fill) |
| `ph-wifi-high` | `WifiHigh` | mobile status bar (fill) |
| `ph-battery-high` | `BatteryHigh` | mobile status bar (fill) |

---

## 9. Interactions / handlers

| Trigger | Handler | Effect |
|---|---|---|
| Scenario switch (harness) | `onState` → `setScenario(id)` | `'drill'` → `scenario:'active', drill:'implementer4', mobileTab:'work'`, appends a co-driving note. Else → `scenario:id, drill:null, mobileTab:(id==='needs'?'needs':'stream')`, clears `extra/resolved/spawned`. (In prod: scenario = real data condition, not a control.) |
| Device toggle (harness) | `onDevice` | `device:'desktop'|'mobile'`. (In prod: responsive breakpoint.) |
| Mobile tab click | `onTab`/`setTab` | `mobileTab = data-id` (`needs`/`stream`/`work`). |
| Click thread chip | `onDrill` | `drill = data-key`; append note `"You stepped into {dlabel}. I'll keep everything else moving."` Right rail swaps to `<ThreadDetail>`. |
| Drill back button | `closeDrill` | `drill = null` → rail returns to overview. |
| Header "N need you" | `goNeeds` | On mobile → `mobileTab:'needs'`. On desktop → no-op (needs zone already visible); could scroll-to in prod. |
| Composer typing | `onComposerInput` | `composer = value`. |
| Composer keydown | `onComposerKey` | ⌘/Ctrl+Enter → `preventDefault` + `onSend`. |
| Send | `onSend` | If non-empty: append user message, clear composer; after **550ms** append canned Overseer reply. |
| Need action button | `onNeedAction` | Add `data-need` id to `resolved` (card disappears via filter); append Overseer ack quoting `data-label`. (Maps to approve/deny/reconcile/answer.) |
| Open delegate | `openDelegate` | `delegateOpen = true` (from composer "+", rail "Delegate", Work-tab CTA, empty-state CTA). |
| Pick type | `pickType` | `delegateType = data-type`; updates recommendation + chip selection. |
| Delegate text | `onDelegateInput` | `delegateText = value`. |
| Confirm delegate | `doDelegate` | Create `th(type, 30+spawned.length, Capitalized(text||'a new task'), 'working', '0m', 6)`, prepend to `spawned` (→ shown at top of `missions[0].threads`); append Overseer ack; close modal. |
| Cancel/close delegate | `closeDelegate` | `delegateOpen=false; delegateText=''`. |
| Redirect input / Send (drill) | (static in mock) | Wire to redirect the thread; copy says it "folds in immediately". |
| Interrupt (drill) | (static) | Wire to interrupt/stop the thread (red). |
| Open raw terminal (drill) | (static link) | Opt-in escape hatch to the underlying terminal surface. |
| Design notes (harness) | `openNotes`/`closeNotes` | Drawer; not part of production. |

**View transitions summary:** overview ↔ detail is a content swap *within the 380px rail* (left
conversation persists). On mobile, detail is a full-screen overlay over the tabs. The delegate
modal is a centered overlay. There is no routing/navigation away from the single Overseer view.

---

## 10. Production notes / mapping to Dispatch

- This is a **brand-new top-level view** ("Overseer") alongside the existing terminal/conversation
  tabs. The Overseer *coordinates*; it explicitly **does not write code** and is "always
  listening" (its value prop vs. a terminal). Each agent thread is ephemeral and typed
  (planner/implementer/researcher/reviewer) — these map to Dispatch agent/session concepts.
- The `scenario`/`device` harness controls and the Design-notes drawer are **not** built; states
  become real data conditions and a responsive breakpoint.
- Reuse Dispatch primitives where possible: `@phosphor-icons/react` (installed), existing theme
  tokens (map `--acc` etc. to the Dispatch palette or keep as local CSS vars), `StatusDot`-style
  atoms. Density/motion/accent should hook into existing settings if available.
- The `dlabel`, denormalized `typeIcon/typeLabel/statusLabel/dotColor/dotAnim/progressW` fields
  in the mock are *view-model* conveniences — in production, derive them from `AgentType`/
  `ThreadStatus` via the `AGENT_TYPE`/`STATUS` registries rather than storing them.
- Live data wiring: status dots breathe while `working`; progress bar only for `working`;
  outcomes are `done` threads collapsed; the Needs-you zone is the subset of threads/events that
  require a human decision, *pulled out* of the rail and promoted.

---

### File references
- Design source (raw): `/private/tmp/claude-501/-Users-davidwebber-Sites-tenex/d9363519-6ce5-4bb6-9f67-be3677be9280/scratchpad/overseer/Overseer.dc.html`
- DC runtime (raw): `/private/tmp/claude-501/-Users-davidwebber-Sites-tenex/d9363519-6ce5-4bb6-9f67-be3677be9280/scratchpad/overseer/support.js`
