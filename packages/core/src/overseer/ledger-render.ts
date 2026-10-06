/**
 * Renders ledger items as the lines an overseer pastes to the user (structured-recap spec,
 * Unit 2 labels and Unit 3 ledger_list). Pure: the caller passes the time and the items.
 *
 * Labels (exact):
 *   You said: "<quote>" (Mon 16:51)                    — a statement
 *   You approved: "<text>" → "<quote>" (Mon 16:51)     — answered on go/decide
 *   Proposed by <author>, not approved                 — open
 *   I read this as: …                                  — its own line, only when reading is set
 *   Imported, not checked                              — imported, no checked quote yet
 *   Withdrawn by overseer: <reason>                    — withdrawn
 */
import type { LedgerItem, LedgerKind } from '../db/ledger.js';

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

function section(title: string, items: LedgerItem[], ctx: RenderContext): string {
  const body = items.length ? items.map((i) => `- ${renderItem(i, ctx)}`).join('\n') : '- none';
  return `${title}:\n${body}`;
}

/**
 * The ledger part of a recap, in this order: Needs you now (open go/decide), Your tests and
 * actions (open do), Decided since the last recap (answered or withdrawn after `lastRecapAt`;
 * everything when null), Parked.
 */
export function renderLedgerSections(
  items: LedgerItem[],
  opts: { now: number; lastRecapAt: string | null; timeZone?: string },
): string {
  const bySeq = new Map(items.map((i) => [i.seq, i] as const));
  const ctx: RenderContext = { now: opts.now, timeZone: opts.timeZone, lookup: (seq) => bySeq.get(seq) ?? null };
  const since = (i: LedgerItem) => opts.lastRecapAt === null || i.updatedAt > opts.lastRecapAt;
  return [
    section('Needs you now', items.filter((i) => i.status === 'open' && (i.kind === 'go' || i.kind === 'decide')), ctx),
    section('Your tests and actions', items.filter((i) => i.status === 'open' && i.kind === 'do'), ctx),
    section('Decided since the last recap', items.filter((i) => (i.status === 'answered' || i.status === 'withdrawn') && since(i)), ctx),
    section('Parked', items.filter((i) => i.status === 'parked'), ctx),
  ].join('\n\n');
}

/** The block the daemon appends to an agent hand-off for `ledgerIds`. */
export function renderHandoffBlock(items: LedgerItem[], ctx: RenderContext): string {
  return [HANDOFF_HEADER, ...items.map((i) => `- ${renderItem(i, ctx)}`)].join('\n');
}
