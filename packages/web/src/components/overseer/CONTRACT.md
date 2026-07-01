# Overseer module — builder contract

This is the contract for the seven region components. The **foundation is done**:
`types.ts`, `data.ts`, `store.ts`, `tokens.css`, `atoms.tsx`, `OverseerView.tsx`,
`OverseerMobile.tsx`. You build the components listed in **§5** below.

Hard rules (from the brief):

- **Inline styles only**, using the CSS custom properties (`color:'var(--acc)'`, …). Do
  **not** add Tailwind utility classes.
- **No prop drilling.** Each component reads what it needs directly from
  `useOverseer()` / `useRenderVals()` and uses the atoms. No component takes data props.
- The spec is the value-exact source of truth:
  `docs/superpowers/specs/2026-06-29-overseer-implementation-spec.md` (§6 = exact
  styling, §7 = verbatim copy, §8 = icons). Backup raw design: the `Overseer.dc.html`
  noted in the spec's "File references".
- **Match the design exactly.** Reproduce string content (smart quotes `“ ”`, em dashes
  `—`, the Unicode minus `−` in diff stats, the middot `·`) verbatim — most of it is
  already baked into the data layer; render it as-is.

---

## 1. Token vars (defined by the view root; just reference them)

Set on `.overseer-root` by `tokens.css` (low-specificity `:where()`) **and** inlined by
`overseerRootStyle` (atoms.tsx). Reference them in inline styles:

`--canvas #08080A` · `--base #0F0F11` · `--pane #141416` · `--elev #1B1B1E`
· `--hover #26262B` · `--border #29292E` · `--acc #3ECF6A` · `--accDim rgba(62,207,106,.12)`
· `--accLine rgba(62,207,106,.4)` · `--yellow #F5C542` · `--yellowDim rgba(245,197,66,.1)`
· `--yellowLine rgba(245,197,66,.35)` · `--red #F0616D` · `--tp #E9E9EC` · `--ts #8E8E96`
· `--tt #5A5A61` · `--mono 'JetBrains Mono'` · `--pulse 2.4s`

Fonts: IBM Plex Sans (default), JetBrains Mono via `var(--mono)`. Keyframes available:
`breathe`, `spin`, `slidein`. The working/listening dots use
`animation:'breathe var(--pulse) ease-in-out infinite'`; the drill "now" step uses
`'spin 1.4s linear infinite'`.

---

## 2. Atoms — `./atoms` (`../atoms` from inside `components/`)

| Export | Signature | Notes |
|---|---|---|
| `Icon` | `({ name: string; weight?: 'regular'\|'bold'\|'fill'; size?: number; color?: string; style?: CSSProperties })` | Maps a `ph-*` class (e.g. `'ph-code'`) to the phosphor component. Covers **every** `ph-*` in spec §8. `ph` → regular, `ph-bold` → `weight="bold"`, `ph-fill` → `weight="fill"`. Default size 16. |
| `StatusDot` | `({ color: string; anim?: string; size?: number })` | 6px circle (default). `anim` is a full CSS animation shorthand string or `'none'`. |
| `TypeIconBox` | `({ icon: string; size?: number })` | Rounded square (28×28 default) holding the agent-type icon; `background:var(--pane)`, `border`, icon color `var(--ts)`. |
| `ProgressBar` | `({ width: string })` | 3px track (`var(--border)`) + accent fill at `width` (e.g. `'62%'`). |
| `MonoLabel` | `({ children; color?; size?; spacing?; style? })` | Uppercase mono tracking label (defaults: `var(--tt)`, 10.5px, `.09em`). |
| `PillButton` | `({ bg; fg; bd; onClick?; children; title?; style? })` | The `btn()`-styled button (padding `7px 13px`, radius 8, 12px/600). Pass `bg/fg/bd` straight from a `NeedAction`. |
| `overseerRootStyle` | `CSSProperties` | Root wrapper style (token vars + base bg/color/font). Used by the two roots; you won't need it. |

`Icon` returns `null` (and warns) for an unknown class — pass classes exactly as they
appear in the data (`AGENT_TYPE[x].icon`, `need.icon`, `step.icon`, etc.).

---

## 3. Store — `./store` (`../store`)

### `useOverseer` — state

| Field | Type | Default |
|---|---|---|
| `scenario` | `Scenario` (`'empty'\|'idle'\|'active'\|'needs'\|'drill'`) | `'needs'` |
| `drill` | `string \| null` (a thread `key`, e.g. `'implementer4'`) | `null` |
| `delegateOpen` | `boolean` | `false` |
| `delegateType` | `AgentType` | `'implementer'` |
| `delegateText` | `string` | `''` |
| `composer` | `string` | `''` |
| `mobileTab` | `MobileTab` (`'needs'\|'stream'\|'work'`) | `'needs'` |
| `extra` | `StreamMessage[]` | `[]` |
| `resolved` | `string[]` (resolved need ids) | `[]` |
| `spawned` | `AgentThread[]` (delegated threads) | `[]` |

### `useOverseer` — actions

| Action | Signature | Effect (spec §9) |
|---|---|---|
| `setScenario` | `(scenario: Scenario) => void` | `'drill'` → `scenario:'active', drill:'implementer4', mobileTab:'work'`, seeds the co-driving note, clears `extra/resolved/spawned`. Else → `scenario, drill:null, mobileTab:(scenario==='needs'?'needs':'stream')`, clears `extra/resolved/spawned`. (Harness-era control; in prod scenario is real data.) |
| `drillInto` | `(key: string, dlabel?: string) => void` | `drill = key`; appends note `"You stepped into {dlabel}. I'll keep everything else moving."` Pass the thread's `dlabel` (e.g. `thread.dlabel`). |
| `closeDrill` | `() => void` | `drill = null`. |
| `openDelegate` | `() => void` | `delegateOpen = true`. |
| `closeDelegate` | `() => void` | `delegateOpen = false; delegateText = ''`. |
| `pickType` | `(type: AgentType) => void` | `delegateType = type`. |
| `setDelegateText` | `(text: string) => void` | `delegateText = text`. |
| `setComposer` | `(text: string) => void` | `composer = text`. |
| `sendDirective` | `() => void` | If trimmed composer non-empty: append user msg, clear composer; after **550ms** append the canned Overseer reply. |
| `needAction` | `(id: string, label: string) => void` | Push `id` to `resolved` (card disappears via filter) + append the Overseer ack quoting `label`. |
| `doDelegate` | `() => void` | Create `th(delegateType, 30+spawned.length, Capitalized(delegateText||'a new task'), 'working', '0m', 6)`, prepend to `spawned`, append the Overseer ack, close the modal. |
| `setMobileTab` | `(tab: MobileTab) => void` | `mobileTab = tab`. |
| `goNeeds` | `() => void` | Sets `mobileTab:'needs'` (mobile jump; no-op visually on desktop). |

Select narrowly, e.g. `const composer = useOverseer(s => s.composer)`,
`const sendDirective = useOverseer(s => s.sendDirective)`. Actions are stable refs.

### `useRenderVals(): RenderVals`

Derived view model (memoized over a shallow state slice). Shape (`types.ts`):

```ts
interface RenderVals {
  ribbon: Ribbon;            // { working, done, needs, hasNeeds }
  needs: Need[];             // unresolved needs only
  missions: Mission[];       // cloned; spawned prepended to missions[0].threads; every thread has dlabel
  stream: StreamMessage[];   // base scenario stream + extra
  drillDetail: ThreadDetail | null;  // detail(drill, missions) when drilled, else null
  hasNeeds: boolean;
  noMissions: boolean;
  emptyMode: boolean;        // scenario === 'empty'
  drillOpen: boolean;
  overviewOpen: boolean;
}
```

`MobileTab` is exported from `store.ts`. All other types from `types.ts`.

---

## 4. Types & helpers — `./types`, `./data`

- `types.ts`: `AgentType`, `ThreadStatus`, `MessageKind`, `AGENT_TYPE`, `STATUS`,
  `AgentThread`, `Outcome`, `Mission`, `StreamMessage`, `NeedAction`, `Need`, `Ribbon`,
  `DrillStep`, `ThreadDetail`, `Scenario`, `RenderVals`.
- `data.ts`: factories `th`/`outc`/`mission`/`m`/`btn`, `CANNED` copy, `baseMissions`,
  `buildScenario`, `detail`, `derive` (already wired into the store). You generally only
  need `AGENT_TYPE` (for the delegate type chips) and the types — the store gives you
  everything else through `useRenderVals()`.

For the **DelegateModal** type chips, build them from `AGENT_TYPE`:
`(['planner','implementer','researcher','reviewer'] as AgentType[]).map(...)`, selected
when `t === delegateType` (selected → `bg:'var(--accDim)', fg:'var(--acc)',
bd:'1px solid var(--accLine)'`; else `bg:'var(--pane)', fg:'var(--ts)',
bd:'1px solid var(--border)'`). Recommendation label = `AGENT_TYPE[delegateType].label`.

---

## 5. Required component files (build these)

Create each at `components/<File>.tsx` with the **exact export name**. Each consumes the
store/atoms directly (no props). Use `useIsMobile()` from `@/hooks/useIsMobile` (or
`../../../hooks/useIsMobile`) to render the desktop vs mobile variant where they differ.

| File | Export | Reads | Renders / notes |
|---|---|---|---|
| `components/Header.tsx` | `OverseerHeader` | `useRenderVals().ribbon`; `useOverseer(goNeeds)`; `useDispatchName()` | **Desktop** header (spec §6 "Header"): brand badge (configurable coordinator name), `dispatch` chip, ribbon (`{needs} need you` yellow→`goNeeds` when `hasNeeds`, `{working} working` w/ breathing dot, `{done} done today`, divider, `Connected`, gear). The mobile header is inline in `OverseerMobile` — Header is desktop-only. |
| `components/NeedsZone.tsx` | `NeedsZone` | `useRenderVals().needs`, `.ribbon.needs`; `useOverseer(needAction)` | Hero queue (spec §6 "Needs zone"): zone header (`Needs you`, `{N} held · everything else is handled`) + a NeedCard per `need`. Conflict → two context panels (`⇆` divider) ; approval → mono `cmds` chips; question → framing only. Action buttons via `PillButton`, `onClick={() => needAction(need.id, action.label)}`. **Mobile**: stacked conflict panels (no `⇆`), omit "raised by Overseer", fill tab height + own scroll. Rendered in desktop left column (only when `hasNeeds`) and the mobile Needs tab. |
| `components/Stream.tsx` | `ConversationStream` | `useRenderVals().stream` | Scrollable message list (spec §6 "Conversation stream"): `msg.isOverseer` / `msg.isUser` / `msg.isNote` variants. Desktop `flex:1` scroll; mobile fills the Stream tab above the composer. |
| `components/Composer.tsx` | `Composer` | `useOverseer(composer, setComposer, sendDirective, openDelegate)` | "Always listening" composer (spec §6 "Composer"): "+" → `openDelegate`, textarea (`value=composer`, `onChange→setComposer`), send → `sendDirective`. `onKeyDown`: ⌘/Ctrl+Enter → `preventDefault()` + `sendDirective()`. Desktop hint row ("Always listening…", "⌘↵ send"); mobile compact hint. |
| `components/WorkRail.tsx` | `OngoingWorkOverview` | `useRenderVals().missions, .noMissions, .emptyMode`; `useOverseer(openDelegate, drillInto)` | Overview (spec §6 "Work rail — overview"): rail header ("Ongoing work" + Delegate) then MissionGroups — mission header (`name`, `summary`), thread chips (`onClick={() => drillInto(thread.key, thread.dlabel)}`; `TypeIconBox`, `StatusDot` w/ `dotAnim`, `ProgressBar width={progressW}` when `showProgress`), dashed outcome cards. `noMissions` → empty state ("No missions yet." + "Delegate a task"). **Mobile** (Work tab): full-width "Delegate a task" button on top, then missions; simpler empty text ("Fire a directive to begin."). |
| `components/ThreadDetail.tsx` | `ThreadDetail` | `useRenderVals().drillDetail`; `useOverseer(closeDrill)` | Drill view (spec §6 "Work rail — thread detail"): header (back→`closeDrill`, `TypeIconBox`, `typeLabel · #id`, `mission`, status dot + `statusLabel · elapsed`), co-driving banner, "Activity" + timeline (`steps`: `Icon name={step.icon}` w/ `step.anim`, connector line, `step.textColor`), current-action chip (`detail.action`), surface note. **Desktop**: redirect footer + Interrupt + "Open raw terminal" (these are static/un-wired per spec §9). **Mobile**: redirect footer only (omit Interrupt / raw-terminal row); fills the overlay `OverseerMobile` provides. Guard `if (!drillDetail) return null`. |
| `components/DelegateModal.tsx` | `DelegateModal` | `useOverseer(delegateText, delegateType, setDelegateText, pickType, doDelegate, closeDelegate)`; `AGENT_TYPE` | Centered overlay (spec §6 "Delegate modal"): header + close→`closeDelegate`, textarea (`value=delegateText`, `onChange→setDelegateText`), "Overseer suggests a **{AGENT_TYPE[delegateType].label}**" line, four type chips (`onClick={() => pickType(t)}`, selected styling per §4), footer Cancel→`closeDelegate` / Delegate→`doDelegate`. Same on desktop + mobile. |

### Render placement (already wired by the roots)

- **Desktop** (`OverseerView.tsx`): header; body row = left column (`NeedsZone` only when
  `rv.hasNeeds`, then `ConversationStream`, then `Composer`) + 380px rail
  (`rv.overviewOpen ? OngoingWorkOverview : ThreadDetail`); `DelegateModal` when
  `delegateOpen`.
- **Mobile** (`OverseerMobile.tsx`): inline header + 3-tab control; tab body =
  `NeedsZone` / (`ConversationStream` + `Composer`) / `OngoingWorkOverview`; full-screen
  overlay wrapping `ThreadDetail` when `drillOpen`; `DelegateModal` when `delegateOpen`.

So your components must render their **own internal desktop/mobile variant** via
`useIsMobile()` — the roots only decide *where* they appear, not which variant.

### Do NOT build (spec §0)

The prototype harness: scenario switcher toolbar, Desktop/Mobile device toggle, Design
notes drawer, and the phone-frame chrome (rounded shell + fake status bar). The `empty`/
`idle`/`active`/`needs`/`drill` scenarios are real data conditions reached through the
store, not a UI control.
