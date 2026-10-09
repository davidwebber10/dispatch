/**
 * The pinned card payload: GET /api/sessions/:sessionId/ledger/card (pinned card spec 2026-10-08,
 * Unit 2). Built by ledger-card.ts.
 *
 * Types only, with no imports, so the web client imports this file directly
 * (packages/web/src/api/types.ts re-exports it) and the two sides cannot drift. The unions repeat
 * the ones in db/ledger.ts; buildLedgerCard assigns those to these, so a new value there fails the
 * build until it is added here.
 */

export type CardKind = 'go' | 'decide' | 'do' | 'statement';
export type CardStatus = 'open' | 'answered' | 'parked' | 'withdrawn' | 'superseded' | 'proposed' | 'decided_by_overseer';
export type CardOrigin = 'live' | 'imported';
export type CardSourceKind = 'plan' | 'doc' | 'agent' | 'thread' | 'pr' | 'issue' | 'user' | 'overseer';

export interface CardOption {
  label: string;
  effect: string;
  /** What a click adds to the message box after "N17: " (see answerKey). */
  answerKey: string;
}

export interface CardSource {
  kind: CardSourceKind;
  ref: string | null;
  /** The file, for an agent-block item ("path#section" is stored in one field). Else null. */
  path: string | null;
  section: string | null;
  /** The source's own ID, such as LR-6. */
  id: string | null;
  /**
   * A `pr` or `issue` source: its GitHub link, when the project's remote is on GitHub (titles and
   * source panel spec 2026-10-09, Unit 5). Else null.
   */
  url: string | null;
}

export interface CardItem {
  seq: number;
  kind: CardKind;
  status: CardStatus;
  text: string;
  /** The overseer's short label (titles spec 2026-10-09, Unit 5); null for an item without one. */
  title: string | null;
  author: string;
  context: string | null;
  options: CardOption[];
  recommendation: string | null;
  why: string | null;
  default: string | null;
  source: CardSource | null;
  blocks: string | null;
  mission: string | null;
  origin: CardOrigin;
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
  index: { seq: number; kind: CardKind; status: CardStatus; text: string; title: string | null; answer: string | null }[];
}
