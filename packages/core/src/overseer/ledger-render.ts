/**
 * Renders ledger items as the lines an overseer pastes to the user (structured-recap spec,
 * Unit 2 labels and Unit 3 ledger_list). Pure: the caller passes the time and the items.
 *
 * Labels (exact):
 *   You said: "<quote>" (Mon 16:51)                    — a statement
 *   You approved: "<text>" → "<quote>" (Mon 16:51)     — answered on go/decide
 *   You reversed the overseer's choice "<choice>": "<quote>" (Mon 16:51) — answered after ledger_decide_self
 *   Proposed by <author>, not approved                 — open
 *   I read this as: …                                  — its own line, only when reading is set
 *   Imported, not checked                              — imported, no checked quote yet
 *   Withdrawn by overseer: <reason>                    — withdrawn
 *
 * Decision cards (spec 2026-10-06, Unit 5): renderCard is the full card for a go or decide item
 * (each field its own paragraph, the option table, the recommended option marked); the one-line
 * forms and the recap sections follow it. The daemon renders them so a card cannot shrink to a
 * bare plan ID as turns go by.
 */
import type { LedgerItem, LedgerKind, LedgerStatus } from '../db/ledger.js';

export const KIND_LABEL: Record<LedgerKind, string> = { go: 'Go', decide: 'Decide', do: 'Do', statement: 'Statement' };

export const HANDOFF_HEADER = 'Owner decisions (verbatim, from the ledger):';

export interface RenderContext {
  /** "Now" in epoch ms, for the age of open items. */
  now: number;
  /** IANA time zone for the "(Mon 16:51)" stamps. Defaults to the daemon's local zone. */
  timeZone?: string;
  /** Finds another item of the same project, for the "Original question" line. */
  lookup?: (seq: number) => LedgerItem | null;
}

/** "Mon 16:51": short weekday plus 24-hour time. */
export function formatStamp(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('hour')}:${part('minute')}`;
}

/** "42m" under an hour, "5h" under two days, else "3d". */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Imported and never confirmed: no checked quote yet. */
export function isUnchecked(item: LedgerItem): boolean {
  return item.origin === 'imported' && item.quote === null;
}

function attribution(item: LedgerItem, stamp: string): string[] {
  const imported = isUnchecked(item) ? ['  Imported, not checked'] : [];
  switch (item.status) {
    // A closed item shows its terminal status and reason first, imported or not.
    case 'withdrawn':
      return [`  Withdrawn by overseer: ${item.reason ?? ''}`, ...imported];
    case 'superseded':
      return ['  Superseded, not approved', ...imported];
    case 'open':
      return imported.length ? imported : [`  Proposed by ${item.author}, not approved`];
    case 'answered':
      if (imported.length) return imported;
      // A reversal: the user answered a decision the overseer had made itself (decided_at is set).
      if (item.decidedAt !== null) return [`  You reversed the overseer's choice "${item.decidedChoice ?? ''}": "${item.quote}"${stamp}`];
      if (item.kind === 'go' || item.kind === 'decide') return [`  You approved: "${item.text}" → "${item.quote}"${stamp}`];
      if (item.kind === 'do') return [`  You said: "${item.quote}"${stamp}`];
      return []; // a statement carries its quote on the first line
    case 'parked':
      return imported.length ? imported : [`  Parked by you: "${item.quote}"${stamp}`];
    case 'proposed':
      return [`  Proposed by ${item.author}, not yet triaged`];
    case 'decided_by_overseer':
      return [`  Decided by overseer: ${item.decidedChoice ?? ''}. Reason: ${item.reason ?? ''}`];
  }
}

/** One item as a block: the first line, then two-space-indented detail lines. */
export function renderItem(item: LedgerItem, ctx: RenderContext): string {
  const id = `N${item.seq}`;
  const stamp = item.quoteAt ? ` (${formatStamp(item.quoteAt, ctx.timeZone)})` : '';
  const lines: string[] = [];
  if (item.kind === 'statement' && !isUnchecked(item)) {
    lines.push(`${id} You said: "${item.quote}"${stamp}`);
  } else {
    const age = item.status === 'open' ? ` (open ${formatAge(ctx.now - Date.parse(item.createdAt))})` : '';
    lines.push(`${id} [${KIND_LABEL[item.kind]}] ${item.text}${age}`);
  }
  if (item.supersedes !== null) {
    const original = ctx.lookup?.(item.supersedes);
    if (original) lines.push(`  Original question (N${original.seq}): "${original.text}"`);
  }
  if (item.recommendation) lines.push(`  Recommendation: ${item.recommendation}`);
  if (item.options && item.options.length) lines.push(`  Options: ${item.options.map((o) => o.label).join(' | ')}`);
  if (item.blocks) lines.push(`  Blocks: ${item.blocks}`);
  lines.push(...attribution(item, stamp));
  if (item.reading) lines.push(`  I read this as: ${item.reading}`);
  return lines.join('\n');
}

// --- decision cards (spec 2026-10-06, Unit 5) ------------------------------------------------

const DAY_MS = 86_400_000;
const STATUS_WORD: Record<LedgerStatus, string> = {
  open: 'Open', proposed: 'Not yet triaged', answered: 'Answered', parked: 'Parked', withdrawn: 'Withdrawn',
  superseded: 'Superseded', decided_by_overseer: 'Decided by overseer',
};
const GO_ACTION = /(?<![\p{L}\p{N}])(merge|deploy|release|push|restart|update)(?![\p{L}\p{N}])/iu;

/** "Oct 1": short month plus day. */
export function formatDay(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(new Date(iso));
}

/** "42 minutes", "3 hours", "2 days" (singular for 1). */
export function formatOpenAge(ms: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');
  return unit(Math.floor(hours / 24), 'day');
}

/** The text with a closing period, unless it already ends a sentence. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** When the item first reached the user (old rows: their creation). */
const sentTime = (item: LedgerItem) => item.sentAt ?? item.createdAt;

const isCardKind = (item: LedgerItem) => item.kind === 'go' || item.kind === 'decide';

/** The short answer for an option: "A" for "A. 5 nights", else the whole label. */
function shortLabel(label: string): string {
  const m = label.match(/^([\p{L}\p{N}]{1,3})[.):]\s/u);
  return m ? m[1] : label;
}

/** A table cell: no pipe and no line break may leak out of it. */
const cell = (s: string) => s.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();

/** "plan `docs/plans/a.md`, section "Risks" (`D3`)", "agent "X"", "PR #12", …; null without a source. */
export function renderSource(item: LedgerItem): string | null {
  const id = item.sourceId ? ` (\`${item.sourceId}\`)` : '';
  const ref = item.sourceRef ?? '';
  switch (item.sourceKind) {
    case 'plan':
    case 'doc':
      return `${item.sourceKind} \`${ref}\`${item.sourceSection ? `, section "${item.sourceSection}"` : ''}${id}`;
    case 'agent': {
      // An agent-block item keeps "path#section" from its `where` in sourceSection.
      if (item.agentTerminalId && item.sourceSection) {
        const hash = item.sourceSection.indexOf('#');
        const file = hash === -1 ? item.sourceSection : item.sourceSection.slice(0, hash);
        const part = hash === -1 ? '' : item.sourceSection.slice(hash + 1);
        if (!file) return `agent "${ref}"${part ? `, section "${part}"` : ''}${id}`;
        const word = /plan/i.test(file) ? 'plan' : 'doc';
        return `${word} \`${file}\`${part ? `, section "${part}"` : ''}${id}, from agent "${ref}"`;
      }
      return `agent "${ref}"${item.sourceSection ? `, section "${item.sourceSection}"` : ''}${id}`;
    }
    case 'pr': return `PR ${ref}${id}`;
    case 'issue': return `issue ${ref}${id}`;
    case 'user': return `your words "${ref}"${id}`;
    case 'overseer': return `overseer${id}`;
    default: return null;
  }
}

/**
 * The full card for a go or decide item. Each field is its own paragraph (a blank line between
 * fields), so markdown never joins two fields. Fields the item lacks (an old #62 row) are left out.
 */
export function renderCard(item: LedgerItem, ctx: RenderContext): string {
  const id = `N${item.seq}`;
  const parts: string[] = [`**${id} · ${item.kind === 'go' ? 'Go' : 'Decide'}:** ${item.text}`];

  const meta = [`Holds up: ${item.blocks ?? 'nothing'}`];
  meta.push(item.status === 'open' ? `Open ${formatOpenAge(ctx.now - Date.parse(sentTime(item)))}` : STATUS_WORD[item.status]);
  const source = renderSource(item);
  if (source) meta.push(`Source: ${source}`);
  if (isUnchecked(item)) meta.push('Imported, not checked');
  if (item.onDefaultSince) meta.push(`Running on the default since ${formatDay(item.onDefaultSince, ctx.timeZone)}`);
  parts.push(meta.join(' · '));

  if (item.supersedes !== null) {
    const original = ctx.lookup?.(item.supersedes);
    if (original) parts.push(`**Original question (N${original.seq}):** "${original.text}"`);
  }
  if (item.context) parts.push(`**Context:** ${item.context}`);
  const options = item.options ?? [];
  if (options.length) {
    const rows = options.map((o) => (o.label === item.recommendation
      ? `| **${cell(o.label)} (recommended)** | ${cell(o.effect)} |`
      : `| ${cell(o.label)} | ${cell(o.effect)} |`));
    parts.push(['| Option | Effect |', '|---|---|', ...rows].join('\n'));
  }
  if (item.recommendation && item.recommendationWhy) parts.push(`**Why ${item.recommendation}:** ${item.recommendationWhy}`);
  else if (item.recommendation) parts.push(`**Recommended:** ${item.recommendation}`);
  if (item.defaultText) parts.push(`**If you do not answer:** ${item.defaultText}`);
  if (item.overseerNote) parts.push(`**Overseer's note:** ${item.overseerNote}`);

  if (item.status === 'open' || item.status === 'proposed') {
    if (item.kind === 'go') {
      const action = item.text.match(GO_ACTION)?.[1]?.toLowerCase() ?? 'approve';
      parts.push(`**Answer with:** \`${id}: ${action}\``);
    } else if (options.length) {
      const pick = options.find((o) => o.label === item.recommendation) ?? options[0];
      parts.push(`**Answer with:** \`${id}: ${shortLabel(pick.label)}\`, or your own words.`);
    } else {
      parts.push(`**Answer with:** \`${id}:\` and your own words.`);
    }
  } else {
    const stamp = item.quoteAt ? ` (${formatStamp(item.quoteAt, ctx.timeZone)})` : '';
    const outcome = attribution(item, stamp).map((l) => l.trim()).join(' ');
    if (outcome) parts.push(`**Outcome:** ${outcome}`);
  }
  if (item.reading) parts.push(`I read this as: ${item.reading}`);
  return parts.join('\n\n');
}

/** "(`LR-12`, type `show N17`)" — the source ID only as a cross-reference next to the N-ID. */
function showHint(item: LedgerItem): string {
  return `(${item.sourceId ? `\`${item.sourceId}\`, ` : ''}type \`show N${item.seq}\`)`;
}

const title = (item: LedgerItem) => `**N${item.seq} · ${item.kind === 'go' ? 'Go' : 'Decide'}:**`;

/** The one-line form of an open decision under "Needs you now". */
export function renderOneLine(item: LedgerItem): string {
  const rec = item.recommendation ? ` Recommended: ${sentence(item.recommendation)}` : '';
  const imported = isUnchecked(item) ? ' Imported, not checked.' : '';
  return `- ${title(item)} ${item.text}${rec} Holds up: ${sentence(item.blocks ?? 'nothing')}${imported} ${showHint(item)}`;
}

/** The one-line form under "Running on defaults", with the start date. */
export function renderDefaultLine(item: LedgerItem, ctx: { timeZone?: string }): string {
  const value = (item.defaultText ?? '').trim().replace(/\.$/, '');
  const since = item.onDefaultSince ? ` since ${formatDay(item.onDefaultSince, ctx.timeZone)}` : '';
  const rec = item.recommendation ? ` Recommended: ${sentence(item.recommendation)}` : '';
  const imported = isUnchecked(item) ? ' Imported, not checked.' : '';
  return `- ${title(item)} ${item.text} Running on the default${value ? ` "${value}"` : ''}${since}.${rec}${imported} ${showHint(item)}`;
}

/** The one-line form of a decision the overseer made itself. */
export function renderOverseerDecisionLine(item: LedgerItem): string {
  return `- **N${item.seq} · Decided by overseer:** ${item.text} → ${sentence(item.decidedChoice ?? '')} ` +
    `Reason: ${sentence(item.reason ?? '')} (Reply "reverse N${item.seq}" to change it.)`;
}

/** "Overseer decisions in the last 7 days: 6. Reversed by you: 1." — the reversals among those decisions. */
export function renderCountLine(items: LedgerItem[], now: number): string {
  const recent = items.filter((i) => i.decidedAt !== null && now - Date.parse(i.decidedAt) <= 7 * DAY_MS);
  const reversed = recent.filter((i) => i.status === 'answered');
  return `Overseer decisions in the last 7 days: ${recent.length}. Reversed by you: ${reversed.length}.`;
}

/** "- 4 proposed decisions from "Readiness planner" (N30, N31, N32, N33).", one line per agent. */
function proposedLines(items: LedgerItem[]): string[] {
  const groups = new Map<string, number[]>();
  for (const i of items) groups.set(i.author, [...(groups.get(i.author) ?? []), i.seq]);
  return [...groups].map(([author, seqs]) =>
    `- ${seqs.length} proposed decision${seqs.length === 1 ? '' : 's'} from "${author}" (${seqs.map((s) => `N${s}`).join(', ')}).`);
}

const listSection = (heading: string, lines: string[]) => `${heading}:\n${lines.length ? lines.join('\n') : '- none'}`;

/**
 * The ledger part of a recap, in this order:
 *   1. Project rules (your words) — only when rules exist.
 *   2. Needs you now — full cards for every decision sent to the user since the last recap, plus
 *      the top 5 of the rest (first the ones that hold up work, then the oldest); one line for
 *      every other open decision. Decisions running on their default are not here.
 *   3. Running on defaults.  4. Your tests and actions.
 *   5. Decided since the last recap — the user's answers, then the overseer's own decisions.
 *   6. Not yet triaged.  7. Parked.  8. The count line.
 * With no recap yet (`lastRecapAt` null), every open decision is new — except an imported one,
 * which never counts as new.
 */
export function renderLedgerSections(
  items: LedgerItem[],
  opts: { now: number; lastRecapAt: string | null; timeZone?: string },
): string {
  const bySeq = new Map(items.map((i) => [i.seq, i] as const));
  const ctx: RenderContext = { now: opts.now, timeZone: opts.timeZone, lookup: (seq) => bySeq.get(seq) ?? null };
  const since = (i: LedgerItem) => opts.lastRecapAt === null || i.updatedAt > opts.lastRecapAt;
  const out: string[] = [];

  const rules = items.filter((i) => i.kind === 'statement' && i.policy && i.status === 'answered');
  if (rules.length) out.push(listSection('Project rules (your words)', rules.map((i) => `- ${renderItem(i, ctx)}`)));

  const open = items.filter((i) => i.status === 'open' && isCardKind(i) && !i.onDefaultSince);
  // An import is a one-time load, not news: an imported decision never counts as new, so the
  // first recap after an import shows the top 5 as cards, not every imported decision
  // (amendment 2026-10-07 to the decision cards spec).
  const isNew = (i: LedgerItem) =>
    i.origin !== 'imported' && (opts.lastRecapAt === null || sentTime(i) > opts.lastRecapAt);
  const rank = (a: LedgerItem, b: LedgerItem) =>
    Number(!a.blocks) - Number(!b.blocks) || sentTime(a).localeCompare(sentTime(b)) || a.seq - b.seq;
  const rest = open.filter((i) => !isNew(i)).sort(rank);
  const cards = [...open.filter(isNew), ...rest.slice(0, 5)].map((i) => renderCard(i, ctx));
  const lines = rest.slice(5).map(renderOneLine);
  out.push(cards.length || lines.length
    ? ['Needs you now:', ...cards, ...(lines.length ? [lines.join('\n')] : [])].join('\n\n')
    : 'Needs you now:\n- none');

  out.push(listSection('Running on defaults', items.filter((i) => i.status === 'open' && i.onDefaultSince).map((i) => renderDefaultLine(i, ctx))));
  out.push(listSection('Your tests and actions', items.filter((i) => i.status === 'open' && i.kind === 'do').map((i) => `- ${renderItem(i, ctx)}`)));
  out.push(listSection('Decided since the last recap', [
    ...items.filter((i) => (i.status === 'answered' || i.status === 'withdrawn') && since(i)).map((i) => `- ${renderItem(i, ctx)}`),
    ...items.filter((i) => i.status === 'decided_by_overseer' && since(i)).map(renderOverseerDecisionLine),
  ]));
  out.push(listSection('Not yet triaged', proposedLines(items.filter((i) => i.status === 'proposed'))));
  out.push(listSection('Parked', items.filter((i) => i.status === 'parked').map((i) => `- ${renderItem(i, ctx)}`)));
  out.push(renderCountLine(items, opts.now));
  return out.join('\n\n');
}

/** The block the daemon appends to an agent hand-off for `ledgerIds`. */
export function renderHandoffBlock(items: LedgerItem[], ctx: RenderContext): string {
  return [HANDOFF_HEADER, ...items.map((i) => `- ${renderItem(i, ctx)}`)].join('\n');
}
