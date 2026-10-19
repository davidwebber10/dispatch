# Design brief: Chat thread visibility in Dispatch

Date: 2026-10-19
Behavior spec: `docs/superpowers/specs/2026-10-19-chat-thread-visibility-design.md`
Paste everything below the line into Claude Design as is.

---

## Prompt

Design a light addition to the Chat screen of Dispatch, a dark web app that runs AI coding
agents ("threads") on a Mac and shows them in a browser on the desktop and on an iPhone. In
Chat, one agent called Dispatch talks with the owner, does small work itself, and starts
threads for large work in many projects. The owner cannot see that delegated work today.
Design: a right pane that lists each project's recent threads with the waiting ones first,
a small "Started" card in the chat the moment a thread starts, the existing thread viewer
opened over Chat, chips that link to spec and plan files, a doc viewer, and a per-project
Docs list. Use the exact tokens, sizes and sample data below. Keep the current look, add as
little as possible, and do not turn Chat into a dashboard. Make desktop frames (1440 by 900,
with a 280 px right pane) and iPhone frames (393 by 852) for the screens and states listed.

## 1. The current look

Dark theme only; there is no light theme. Flat surfaces, 1 px hairline borders, no
gradients, few shadows.

### Colors

| Token | Value | Use |
|---|---|---|
| `--color-canvas` | `#08080A` | app backdrop |
| `--color-base` | `#0F0F11` | chat column |
| `--color-pane` | `#141416` | right pane, toolbar |
| `--color-elevated` | `#1B1B1E` | cards, inputs, chips |
| `--color-hover` | `#26262B` | hover |
| `--color-border` | `#29292E` | 1 px borders and dividers |
| `--color-accent` | `#3ECF6A` (green) | working, primary actions. The owner can change this color, so never use it alone to mean "working": pair it with a shape or a word |
| `--color-status-yellow` | `#F5C542` | needs you, waiting |
| `--color-status-red` | `#F0616D` | error |
| `--color-text-primary` | `#E9E9EC` | main text |
| `--color-text-secondary` | `#8E8E96` | secondary text |
| `--color-text-tertiary` | `#5A5A61` | meta text, placeholders |

Text selection: accent at 25 % opacity.

### Type

- Sans: IBM Plex Sans. Mono: JetBrains Mono.
- Chat reply text: 14.5 px, line height 1.75.
- Card text: 13.5 px, line height 1.5. Card preview: 12.5 px, secondary, 2 lines.
- Tool rows, one line each: mono 12.5 px, tertiary, a small caret and a wrench icon.
- Pane section label: 600 12 px, uppercase, letter spacing 0.04em, secondary ("PROJECTS").
- Pane project name: 600 14 px, primary.
- Pane counts: mono 12 px, tertiary; yellow when a thread needs you
  ("2 live · 1 need you · 3 open").
- Small mono labels (for example a project tag above a user bubble): 500 10 px, letter
  spacing 0.06em, tertiary.

### Radius and spacing

- Radius tokens: 5 px (sm), 8 px (md, cards and buttons), 12 px (lg), 16 px (xl).
- There are no spacing tokens; the app uses these fixed values: 4, 6, 8, 10, 12, 16 px.
- Cards: elevated background, 1 px border, radius 8, padding 10 px by 12 px.
- Pane: padding 12 px, 10 px between project cards.
- Toolbar buttons: 32 px high, radius 8, 1 px border, elevated background, 12.5 px text,
  a 15 px icon and a label.
- Icons: Phosphor, regular weight, 13 to 16 px.
- Touch targets on the iPhone: at least 44 px high.

### Layout

- **Desktop:** a 52 px icon rail on the left; the chat column in the middle (flexible); the
  right pane as a 280 px aside with a 1 px left border. Above the chat column, a toolbar: a
  memory search box, a "Memory" button and a "Projects" button that shows or hides the
  pane. The composer is at the bottom of the chat column. User messages are right-aligned
  bubbles (max 82 % wide); Dispatch replies are full-width text.
- **iPhone:** one column, a bottom tab bar (Projects, Chat, Pinned, Analytics, Settings).
  The pane is hidden; the toolbar "Projects" button opens it as a bottom sheet. Respect the
  safe areas (notch and home bar).

## 2. What NOT to change

- The colors, fonts, radius values, the icon rail, the toolbar layout, the composer, the
  user bubble and the Dispatch reply style.
- The thread viewer modal (S5) itself: only add one small button to its header.
- The report card's look (S4): only add doc link chips inside its text.
- The pane width stays 280 px unless a design note gives a strong reason.
- No board, columns, charts, drag and drop, or ledger and decision cards. No buttons on the
  pane rows (a row opens the thread; the viewer has the controls).
- No new colors except the three status colors above.

## 3. Screens and states

Design each screen at desktop width and at iPhone width, unless it says desktop only.

### S1. Right pane, per project

The pane lists only threads with recent activity, so it stays short with 18 projects.

- **Needs you section** at the top, only when a thread waits: a yellow accent (for example a
  2 px yellow left border), the thread name, the project, who started it, and the question
  in up to 3 lines.
- **One block per project:** the name, the counts line, then thread rows.
  Row line 1: a state dot, the name (one line), the start time.
  Row line 2 (mono, small): who started it, the harness, the latest step.
  Order: needs you, working, queued, error, done.
- **Who started it** tags: "Chat", "Overseer", "You", "Role" (a scheduled run), and "via"
  plus a thread name (a thread that another thread started).
- **Done today (N):** one closed line per project; open, it lists the finished rows, dimmer.
- **"+N more"** after 6 rows.
- A project with only open items: its name and counts, no rows.
- States: loading (first load); empty ("No project activity yet."); unavailable ("Projects
  are unavailable."); a note when the list is cut ("Some projects are not shown").

### S2. Toolbar "Projects" button

No badge; a yellow badge with the need-you count. On the iPhone the badge is the main signal,
because the pane is a closed sheet.

### S3. "Started" card in the chat

A one-line card, lighter than a report card, among the turn's tool rows.

- Starting: "Starting" and the name, dim, not tappable.
- Started: "Started", the thread name, the project, the harness, and a live state chip
  (working, needs you, done, error).
- An old thread: no chip.
- Could not start: "Could not start", the name, the first line of the error, in red.
- Up to 2 doc link chips (S6) when the task names a doc.
- Show it in context: the chat sample in section 4.

### S4. Report card (folded) with doc links

It exists today: a briefcase icon, the thread name in bold, a 2-line preview; a long report
folds behind a caret; open, it shows the full text and an "Open thread" button. Add doc link
chips inside the text. States: short card; folded; open.

### S5. Thread viewer opened from Chat

It exists: a large centered modal on desktop (about 880 px wide, 82 % of the height), a
full-height sheet on the iPhone. It shows the thread's own chat, its name, task summary and
stats, and Interrupt, Stop and Archive. Show it over the Chat screen, add one small "Open in
Threads" button to its header, and show a thread that waits with its question.

### S6. Doc link chip

A path to a `.md` file becomes a chip: a small file icon and the file name, the full path on
hover. States: in a reply (from plain text and from inline code); in a report card; a long
absolute path; hover; keyboard focus.

### S7. Doc viewer

A modal (desktop) or a sheet (iPhone) that shows a spec or plan as rendered Markdown.

- **Header:** the file name; a location chip; a "vs main" chip; the doc's own status line;
  the modified time; a note when there are several copies.
- Location chip forms: "main"; "worktree chat-visibility-spec on spec/chat-thread-visibility";
  "branch origin/spec/telemetry, as of the last fetch".
- "vs main" chip forms: "on main"; "changed here"; "not on main".
- **Actions on the Mac:** Reveal in Finder, Open in editor, Copy path, Open the thread that
  wrote it.
- **Actions elsewhere (iPhone, another computer):** Copy path, Open the thread that wrote it.
- States: loading; not found ("This file is not in the project, its worktrees or its
  branches."); refused ("This path is outside the project."); too large; a back arrow after a
  link inside the doc opened another doc.

### S8. Per-project Docs list

In each project block of the pane, after the threads: "Docs (N)", closed by default.

- Open: rows, newest first. Row: the file name (long dated names, so plan for a wrap or a
  middle cut), the status line, the location chip, the "vs main" chip, the modified time,
  the writer thread, and "+1 copy" when there are other copies.
- States: closed; loading; rows; empty ("No specs or plans."); "+N more" after 8.

### S9. iPhone versions

The Projects sheet with the S1 states and S8; the toolbar with the badge; a "Started" card at
393 px; the thread viewer and the doc viewer as sheets.

## 4. Sample data (use it in every screen)

Time now: Monday 19 October, 11:45.

### Projects and counts

| Project | Counts |
|---|---|
| Studio | 1 live · 0 need you · 2 open |
| Product Rollup | 0 live · 1 need you · 4 open |
| Dispatch | 1 live · 0 need you · 3 open |
| Data Analytics | 0 live · 0 need you · 1 open |

### Threads

| Project | Name | Harness | Started by | State | Started | Latest step or question |
|---|---|---|---|---|---|---|
| Studio | Fix PR #2 review findings | Claude | Chat | working | 10:42 | Running: pnpm test |
| Studio | Re-review PR #2 | Codex | via Fix PR #2 review findings | queued | 10:44 | queued |
| Product Rollup | Reconcile June totals | Codex | Overseer | needs you | 09:58 | "Use the warehouse view or the raw orders table for the June totals?" (options: Warehouse view, Raw orders) |
| Product Rollup | Export catalog CSV | Claude | You | error | 08:30 | stopped with an error |
| Product Rollup | Nightly totals check | Claude | Role | done | 06:00 | finished 06:07 |
| Dispatch | Plan: chat thread visibility | Claude | Chat | working | 11:05 | Editing 2026-10-19-chat-thread-visibility-design.md |
| Dispatch | Release notes check | Claude | You | done | 09:15 | finished 09:40 |
| Dispatch | Review PR 91 (Codex) | Codex | Overseer | done | 08:02 | finished 08:51 |
| Data Analytics | (no rows today: the "only open items" state) | | | | | |

### Chat sample (for S3, S4, S6)

1. User (project tag "Studio"): "Fix the two review findings on PR #2, and start a planner
   for chat thread visibility in Dispatch."
2. Dispatch: "Starting two threads: one fixes PR #2 in Studio, one plans the chat visibility
   work in Dispatch. I will tell you when they report."
3. Started card: "Fix PR #2 review findings · Studio · Claude", chip "working".
4. Started card: "Plan: chat thread visibility · Dispatch · Claude", chip "working", and a
   doc link chip "2026-10-13-endless-chat-design.md" from its task.
5. Later, a long report card, shown folded and open: "[Plan: chat thread visibility] report:
   The spec is written and pushed. Doc:
   /Users/owner/Projects/dispatch/.worktrees/chat-visibility-spec/docs/superpowers/specs/2026-10-19-chat-thread-visibility-design.md
   (branch spec/chat-thread-visibility). Eight open questions, each with a recommendation.
   The right pane gets a thread list per project, waiting threads first, and a Started card
   in the chat." The path becomes the doc chip "2026-10-19-chat-thread-visibility-design.md".
6. A failed start: "Could not start Export catalog CSV: unknown project: catalog".

### Docs list (project Dispatch)

| File | Status line | Location | vs main | Modified | Writer |
|---|---|---|---|---|---|
| 2026-10-19-chat-thread-visibility-design.md | draft, awaiting owner review | worktree chat-visibility-spec on spec/chat-thread-visibility | not on main | 11:31 | Plan: chat thread visibility |
| 2026-10-19-chat-thread-visibility-design-brief.md | (none) | worktree chat-visibility-spec on spec/chat-thread-visibility | not on main | 11:44 | Plan: chat thread visibility |
| 2026-10-15-telemetry-design.md | approved | branch origin/spec/telemetry, as of the last fetch | changed here | Fri 16:20 | (unknown) |
| 2026-10-13-endless-chat-design.md | approved in brainstorming, awaiting spec review | main | on main | 13 Oct | (unknown) |

### Doc viewer sample (S7)

Open `2026-10-19-chat-thread-visibility-design.md` from the worktree copy, on the Mac. Show
its first screen: the title "Chat thread visibility: design", the date and status lines, and
the start of "1. Goal" with its numbered list.

## 5. What to deliver

- S1 to S9 at desktop width; S1, S2, S3, S5, S7, S8 and S9 at iPhone width.
- Each state in section 3, as frames or as variants.
- A note for each place where the design differs from this brief, with the reason.
