# Claude Design brief — Control Plane analytics in Dispatch

Paste this brief into Claude Design. Attach a screenshot of the current Analytics screen with it.

> This brief is the input to the mockups. Where it differs from
> `2026-09-29-control-plane-analytics-design.md`, the design spec is correct. Claude Design found
> five problems in the numbers and definitions here; the spec resolves them.

## 1. Context

Dispatch is a local web app that runs AI coding agents. Each project can have a **Control Plane**:
a coordinator agent that starts typed worker agents (researcher, planner, implementer, reviewer,
design-reviewer, code-reviewer) and groups them into **missions**.

The **Analytics** screen is one scrolling pane today. It shows token and turn usage: a filter row
(project, range, provider), a row of 6 KPI tiles, and chart blocks (tokens by model, output tokens,
turns by outcome, average turn time, and more). On desktop, the icon rail opens it as a full view.
On mobile, the bottom tab "Usage" opens it.

We will add Control Plane metrics. This is the first time that Analytics has more than one pane.
The change must look good, and it must not confuse the user about where they are or what the
filters do.

## 2. What to design

Design **two layout variants** so that we can compare them. For each variant, make four frames:

| Frame | Size |
|---|---|
| Desktop, Usage content | 1440 × 1100 |
| Desktop, Control Plane content | 1440 × 1100 |
| Mobile, Usage content | 390 × 844 |
| Mobile, Control Plane content | 390 × 844 |

### Variant 1 — a view switch in the title row

- Put a segmented control beside the "Analytics" title: `Usage | Control Plane`.
- It must read as a switch between two views of one screen, not as document tabs.
- The filter row stays the same in both views: the same controls, in the same place, with the same
  values. A change of view never moves or resets a filter.
- The screen remembers the last view. The first visit opens Usage.
- On mobile, rename the bottom tab from "Usage" to "Analytics", so the word "Usage" does not show
  twice. The switch sits under the title and spans the full width.

### Variant 2 — one pane with two sections

- Keep one scrolling pane. Add a section header "Control Plane" below the Usage blocks.
- Add a thin sticky bar under the filter row with two links: `Usage · Control Plane`. A click
  scrolls to the section. The bar highlights the section that is on screen.
- The filter row applies to both sections.
- On mobile, the sticky bar sits under the filters. Keep the bottom tab name "Usage" or rename it to
  "Analytics", whichever reads better; say which one you chose.

### The Provider filter in the Control Plane content

In Usage, "Provider" filters turns by the agent CLI (claude-code, codex, grok, opencode). In the
Control Plane content, it filters agents by the same CLI. Keep the control in both, with the same
label.

## 3. Visual system (use these exact values)

Dark theme only.

| Token | Value |
|---|---|
| Canvas (behind panels) | `#08080A` |
| Pane / chart surface | `#141416` |
| Panel (KPI tiles and blocks) | `#1B1B1E` |
| Hover | `#26262B` |
| Border and grid lines | `#29292E` |
| Text, primary | `#E9E9EC` |
| Text, secondary | `#8E8E96` |
| Text, tertiary | `#5A5A61` |
| Sans font | IBM Plex Sans |
| Mono font | JetBrains Mono |

- **KPI tile:** a label in mono, uppercase, letter-spaced, 11 px, secondary text. The value is in
  sans, about 22 px, semibold, primary text. An optional small caption in secondary text.
- **Block title:** mono, uppercase, letter-spaced, 11 px, secondary text, for example
  `AGENTS STARTED PER DAY · BY TYPE`.
- **Chart series colors, in this order:** `#3987e5`, `#d95926`, `#199e70`, `#c98500`, `#d55181`.
  "Other" is `#6b6b73`. This palette passed a colorblind check on `#141416`.
- **Status colors are reserved** for states, never for a series: green `#3ECF6A`, yellow `#F5C542`,
  red `#F0616D`.

Chart rules:

- Use a maximum of 5 series in one chart. Do not repeat the problem in the current "tokens by
  model" chart, where most series fall into gray "Other".
- Use one y-axis in each chart.
- A series keeps the same color in every chart and with every filter.
- Show a legend when a chart has 2 or more series. Put value labels only where they help.
- Every bar and point has a hover tooltip.
- Text is always in text colors, never in a series color.

## 4. Control Plane content (real data: last 30 days, all projects)

### KPI row (6 tiles)

| Label | Value | Caption |
|---|---|---|
| SESSIONS | 15 | +1 new in range |
| ACTIVE DAYS | 20 | days with a Control Plane turn |
| MISSIONS STARTED | 15 | |
| MISSIONS COMPLETED | 11 | info icon; tooltip: "No working or queued agent, and no activity for 7 days." |
| AGENTS STARTED | 437 | |
| CONTROL PLANE TOKEN SHARE | 27% | 1.6B of 6.1B tokens |

### Charts

1. **AGENTS STARTED PER DAY · BY TYPE**: stacked columns, one column per day, 5 series. The 30-day
   totals are implementer 196, researcher 169, review gate 44 (design-reviewer and code-reviewer
   together), planner 26, and reviewer 2. 20 of the 30 days have agents. The busiest day has 49 and the quietest has 2. The other 10 days have 0.
2. **TOKENS PER DAY · CONTROL PLANE VS AGENTS**: stacked columns, 2 series. The 30-day totals are
   Control Plane 1.65B and agents 4.42B. The largest day is about 1.2B.
3. **MISSIONS COMPLETED PER WEEK**: columns, 1 series, 5 weeks. The values are 9, 1, 1, 0, and 0.
   A mission counts as completed only after 7 idle days, so the last week is always 0 or low.
   Show that with a muted note or a hatched last column, for example "still settling".
4. **MESSAGES PER DAY**: 2 lines, "You → Control Plane" (471 in 30 days) and "Control Plane →
   agents" (446 in 30 days). The average is 23 per day for each line, and the maximum is 49.

### Tables

**BY PROJECT** (show the active projects, then one muted row: "10 projects had no Control Plane
activity in this range")

| Project | Sessions | Active days | Missions started | Missions completed | Agents | CP token share |
|---|---|---|---|---|---|---|
| PW Legacy | 1 | 14 | 3 | 3 | 146 | 19% |
| POLYWOOD Analytics | 1 | 7 | 3 | 0 | 100 | 29% |
| PW Explorer (OS) | 1 | 14 | 4 | 8 | 97 | 32% |
| Shopify Product Rollup | 1 | 16 | 4 | 0 | 93 | 38% |
| Salsify Automations App | 1 | 1 | 1 | 0 | 1 | 25% |

**BY AGENT TYPE**

| Type | Agents | Avg turn | Tokens | CLI mix |
|---|---|---|---|---|
| implementer | 196 | 6m 50s | 2.41B | claude-code 196 |
| researcher | 169 | 12m 14s | 1.60B | claude-code 169 |
| code-reviewer | 30 | 4m 15s | 81M | codex 19 · claude-code 11 |
| planner | 26 | 21m 57s | 271M | claude-code 26 |
| design-reviewer | 14 | 5m 12s | 36M | claude-code 14 |
| reviewer | 2 | 5m 23s | 22M | claude-code 2 |

**MISSIONS** (the newest activity first; a status chip that uses text and a shape, not color alone)

| Mission | Project | Agents | Review gates | Length | Status |
|---|---|---|---|---|---|
| Sage consumers | POLYWOOD Analytics | 46 | 13 | 14 days | Active |
| PLM Progress Review | PW Explorer (OS) | 21 | 3 | 16 days | Active |
| Rollup pipeline hardening | Shopify Product Rollup | 11 | 2 | 2 days | Active |
| DATA-8 row-level validation | POLYWOOD Analytics | 52 | 11 | 5 days | Active |
| Delta engine implementation | Shopify Product Rollup | 131 | 9 | 41 days | Active |
| PW Career History & Resume | PW Legacy | 260 | 0 | 44 days | Completed |
| PLM UAT Round 1 | PW Explorer (OS) | 49 | 2 | 9 days | Completed |

## 5. What we will judge

- Does the user always know which view or section they are in?
- Do the filters read as shared, and does nothing jump when the view changes?
- Does the Control Plane content look like part of the same screen as Usage?
- Does it work at 390 px wide without horizontal scroll, except inside a table?
