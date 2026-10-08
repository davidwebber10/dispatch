// Overseer — pure helpers for the pinned decision card (pinned card spec 2026-10-08, Units 7 and 8).
// The daemon computes the sections (GET …/ledger/card); these only format what the card draws.

import type { CardItem, CardOption, CardSource, LedgerCard } from '../../api/types';

/** The open decisions that need the user now: the full cards plus the one-line rest. */
export function openDecisionCount(card: LedgerCard | null): number {
  return card ? card.sections.needsYou.cards.length + card.sections.needsYou.lines.length : 0;
}

const where = (s: CardSource) => `${s.section ? ` › ${s.section}` : ''}${s.id ? ` · ${s.id}` : ''}`;

/** "plan · path › section · plan ID", "PR #62", "your thread "Scratch"", … — the chat card's source line, shortened. */
export function formatCardSource(s: CardSource): string {
  switch (s.kind) {
    case 'plan':
    case 'doc':
      return `${s.kind} · ${s.ref ?? ''}${where(s)}`;
    case 'agent':
      // An agent-block item names the file the decision lives in.
      if (s.path) return `${/plan/i.test(s.path) ? 'plan' : 'doc'} · ${s.path}${where(s)} · from agent "${s.ref ?? ''}"`;
      return `agent "${s.ref ?? ''}"${where(s)}`;
    case 'thread': return `your thread "${s.ref ?? ''}"${where(s)}`;
    case 'pr': return `PR ${s.ref ?? ''}${s.id ? ` · ${s.id}` : ''}`;
    case 'issue': return `issue ${s.ref ?? ''}${s.id ? ` · ${s.id}` : ''}`;
    case 'user': return `your words "${s.ref ?? ''}"`;
    case 'overseer': return `overseer${s.id ? ` · ${s.id}` : ''}`;
  }
}

/**
 * What a click on the card adds to the message box (Unit 8): a decide option its answerKey
 * ("N17: A"), the Approve row of a go item "N34: approve", the Done link of an action "N55: done".
 * The message stays the user's own: the daemon checks its words as for any typed answer.
 */
export function answerText(item: CardItem, option?: CardOption): string {
  if (option) return `N${item.seq}: ${option.answerKey}`;
  return `N${item.seq}: ${item.kind === 'go' ? 'approve' : 'done'}`;
}

/**
 * What happened to an item, for its line and its full card: the user's answer (or a reversal of the
 * overseer's own choice), the overseer's choice, the withdrawal reason, the default it runs on.
 * Null for an open item that waits on the user.
 */
export function outcomeText(item: CardItem): string | null {
  const unchecked = item.origin === 'imported' && item.quote === null;
  switch (item.status) {
    case 'open': {
      if (!item.onDefaultSince) return null;
      const value = (item.default ?? '').trim().replace(/\.$/, '');
      const since = new Date(item.onDefaultSince).toLocaleDateString([], { month: 'short', day: 'numeric' });
      return `Running on the default${value ? ` "${value}"` : ''} since ${since}`;
    }
    case 'answered':
      if (unchecked) return 'Imported, not checked';
      if (item.kind === 'statement') return 'Noted';
      if (item.choice !== null) return `You reversed the overseer's choice "${item.choice}": "${item.quote ?? ''}"`;
      return `Your answer: "${item.quote ?? ''}"`;
    case 'parked': return unchecked ? 'Parked, imported, not checked' : `Parked: "${item.quote ?? ''}"`;
    case 'withdrawn': return `Withdrawn: ${item.reason ?? ''}`;
    case 'decided_by_overseer': return `Decided by overseer: ${item.choice ?? ''}`;
    case 'superseded': return 'Superseded';
    case 'proposed': return 'Not yet triaged';
  }
}

/** "14:02" today, else "Oct 7 14:02": when the ledger last changed. */
export function formatUpdated(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}
