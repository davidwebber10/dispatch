/**
 * The pinned card's data (pinned card spec 2026-10-08, Unit 2): the sections of ledgerSections
 * (Unit 1) as JSON card items, for the web app to draw. Pure: the caller passes the time, the
 * items and the time of the last recap. The web app draws every field itself, so each option is
 * a real click target; nothing here is markdown.
 */
import type { LedgerItem, LedgerKind, LedgerOrigin, LedgerSourceKind, LedgerStatus } from '../db/ledger.js';
import { ledgerSections, projectRules } from './ledger-render.js';

export interface CardOption {
  label: string;
  effect: string;
  /** What a click adds to the message box after "N17: " (see answerKey). */
  answerKey: string;
}

export interface CardSource {
  kind: LedgerSourceKind;
  ref: string | null;
  /** The file, for an agent-block item ("path#section" is stored in one field). Else null. */
  path: string | null;
  section: string | null;
  /** The source's own ID, such as LR-6. */
  id: string | null;
}

export interface CardItem {
  seq: number;
  kind: LedgerKind;
  status: LedgerStatus;
  text: string;
  author: string;
  context: string | null;
  options: CardOption[];
  recommendation: string | null;
  why: string | null;
  default: string | null;
  source: CardSource | null;
  blocks: string | null;
  mission: string | null;
  origin: LedgerOrigin;
  sentAt: string | null;
  isNew: boolean;
  onDefaultSince: string | null;
  overseerNote: string | null;
  /** The question this item supersedes, when it does. */
  original: { seq: number; text: string } | null;
  /** A decided item: the overseer's choice, the user's quote, or the reason (withdrawn, decided by the overseer). */
  choice: string | null;
  quote: string | null;
  quoteAt: string | null;
  reason: string | null;
  reading: string | null;
}

export interface LedgerCard {
  /** The newest change of any item of the project; null for an empty ledger. */
  updatedAt: string | null;
  lastRecapAt: string | null;
  sections: {
    rulesCount: number;
    needsYou: { cards: CardItem[]; lines: CardItem[] };
    onDefaults: CardItem[];
    actions: CardItem[];
    decidedSince: CardItem[];
    untriaged: CardItem[];
    parked: CardItem[];
    counts: { overseerDecisions: number; reversed: number };
  };
  /** The project rules in force, for the read-only list. */
  rules: { seq: number; quote: string; reading: string | null }[];
  /** Every item of the project, any status: what the ledger chips in the chat need. */
  index: { seq: number; kind: LedgerKind; status: LedgerStatus; text: string; answer: string | null }[];
}

/**
 * The short answer for an option: the label's leading token when the label starts with one to
 * three letters or digits and a full stop ("A. 5 nights" → "A"); otherwise the whole label. The
 * full stop must end the token, so "1.5 nights" is a whole label.
 */
export function answerKey(label: string): string {
  const m = label.match(/^([\p{L}\p{N}]{1,3})\.(?:\s|$)/u);
  return m ? m[1] : label;
}

/** The source in plain fields. An agent-block item keeps "path#section" from its `where` in sourceSection. */
function cardSource(item: LedgerItem): CardSource | null {
  if (!item.sourceKind) return null;
  let path: string | null = null;
  let section = item.sourceSection;
  if (item.sourceKind === 'agent' && item.agentTerminalId && section) {
    const hash = section.indexOf('#');
    path = (hash === -1 ? section : section.slice(0, hash)) || null;
    section = hash === -1 ? null : section.slice(hash + 1) || null;
  }
  return { kind: item.sourceKind, ref: item.sourceRef, path, section, id: item.sourceId };
}

export function buildLedgerCard(items: LedgerItem[], opts: { now: number; lastRecapAt: string | null }): LedgerCard {
  const bySeq = new Map(items.map((i) => [i.seq, i] as const));
  const s = ledgerSections(items, opts);
  const fresh = new Set(s.newSeqs);
  const toCard = (i: LedgerItem): CardItem => {
    const original = i.supersedes !== null ? bySeq.get(i.supersedes) : undefined;
    return {
      seq: i.seq, kind: i.kind, status: i.status, text: i.text, author: i.author,
      context: i.context,
      options: (i.options ?? []).map((o) => ({ label: o.label, effect: o.effect, answerKey: answerKey(o.label) })),
      recommendation: i.recommendation, why: i.recommendationWhy, default: i.defaultText,
      source: cardSource(i),
      blocks: i.blocks, mission: i.mission, origin: i.origin, sentAt: i.sentAt, isNew: fresh.has(i.seq),
      onDefaultSince: i.onDefaultSince, overseerNote: i.overseerNote,
      original: original ? { seq: original.seq, text: original.text } : null,
      choice: i.decidedChoice, quote: i.quote, quoteAt: i.quoteAt, reason: i.reason, reading: i.reading,
    };
  };
  return {
    updatedAt: items.reduce<string | null>((max, i) => (max === null || i.updatedAt > max ? i.updatedAt : max), null),
    lastRecapAt: opts.lastRecapAt,
    sections: {
      rulesCount: s.rulesCount,
      needsYou: { cards: s.needsYou.cards.map(toCard), lines: s.needsYou.lines.map(toCard) },
      onDefaults: s.onDefaults.map(toCard),
      actions: s.actions.map(toCard),
      decidedSince: s.decidedSince.map(toCard),
      untriaged: s.untriaged.map(toCard),
      parked: s.parked.map(toCard),
      counts: s.counts,
    },
    rules: projectRules(items).map((i) => ({ seq: i.seq, quote: i.quote ?? i.text, reading: i.reading })),
    index: items.map((i) => ({
      seq: i.seq, kind: i.kind, status: i.status, text: i.text,
      answer: i.status === 'decided_by_overseer' ? i.decidedChoice : i.quote,
    })),
  };
}
