/**
 * The ledger's quote check (structured-recap spec, Unit 2 rules 2 and 6). Pure: it takes the
 * overseer's logged messages and decides whether the user really wrote the quoted words.
 *
 * - The match ignores case and runs of white space.
 * - Only `user` messages count; `canned`, `coordinator` and `daemon` messages never match.
 * - With `after`, only messages sent strictly after that time count.
 * - The earliest matching message wins.
 * - Word edges: a match counts only when it does not start or end inside a word of the message.
 *   Where the quote's first (or last) character is a letter or digit, the message character just
 *   before (or after) the match must not be one. So "N1" is not in "N12: yes" and "merge" is not
 *   in "emerged" or "merged". This check comes first, so part of an ok-word ("k" from "ok", "kay"
 *   from "okay") fails as `not_found`.
 * - The leading ok span is measured on the MESSAGE: an ok-word (ok, okay, k, kk — any case) at
 *   its start, then any punctuation and spaces. A match that starts inside that span starts after
 *   it. If nothing remains, the check fails as `ok_only`. An "ok" in the middle of a message is
 *   never removed.
 * - A quote with no letter or digit left never counts (`not_found`, or `ok_only` when the match
 *   started inside the ok span).
 * - The stored quote is the user's own text for the matched words (their case, their spacing).
 */

export const OK_ONLY_ERROR = "An 'ok' at the start of a message is not an answer. Ask the user.";

export interface QuoteCandidate {
  id: number;
  sentAt: string;
  source: string;
  text: string;
}

export type QuoteMatch =
  | { ok: true; messageId: number; sentAt: string; quote: string }
  | { ok: false; reason: 'not_found' | 'ok_only' };

const OK_PREFIX = /^(?:okay|ok|kk|k)(?![\p{L}\p{N}])[\s\p{P}]*/u;
const WORD_CHAR = /^[\p{L}\p{N}]$/u;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/** True when the character at `i` exists and is a letter or digit. Works on UTF-16 units, so an
 *  astral character reads as not-a-word-character (no ID or action word uses one). */
const isWordAt = (s: string, i: number): boolean => i >= 0 && i < s.length && WORD_CHAR.test(s[i]);

/** Lower-cased text with each run of white space collapsed to one space, plus, for every
 *  output character, the index of the original character it came from. */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < s.length;) {
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (/\s/u.test(ch)) {
      if (!inSpace) { norm += ' '; map.push(i); inSpace = true; }
    } else {
      inSpace = false;
      const lower = ch.toLowerCase();
      for (let k = 0; k < lower.length; k++) { norm += lower[k]; map.push(i); }
    }
    i += ch.length;
  }
  return { norm, map };
}

/** The form both sides are compared in: lower case, white space runs collapsed, trimmed. */
export function normalizeForMatch(s: string): string {
  return normalizeWithMap(s).norm.trim();
}

export function findQuote(quote: string, messages: readonly QuoteCandidate[], opts: { after: string | null }): QuoteMatch {
  const needle = normalizeForMatch(quote);
  if (!needle) return { ok: false, reason: 'not_found' };
  const candidates = messages
    .filter((m) => m.source === 'user' && (opts.after === null || m.sentAt > opts.after))
    .sort((a, b) => (a.sentAt === b.sentAt ? a.id - b.id : a.sentAt < b.sentAt ? -1 : 1));
  const edgeAtStart = isWordAt(needle, 0);
  const edgeAtEnd = isWordAt(needle, needle.length - 1);
  let sawOkOnly = false;
  for (const msg of candidates) {
    const { norm, map } = normalizeWithMap(msg.text);
    const lead = norm.startsWith(' ') ? 1 : 0; // leading white space does not move "the start"
    const okSpan = norm.slice(lead).match(OK_PREFIX);
    const okEnd = okSpan ? lead + okSpan[0].length : lead; // the ok span is [lead, okEnd)
    for (let at = norm.indexOf(needle); at !== -1; at = norm.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (edgeAtStart && isWordAt(norm, at - 1)) continue; // starts inside a word
      if (edgeAtEnd && isWordAt(norm, end)) continue; // ends inside a word
      const inOkSpan = at < okEnd;
      const start = inOkSpan ? okEnd : at;
      if (start >= end) { sawOkOnly = true; continue; }
      const last = map[end - 1];
      const words = msg.text.slice(map[start], last + String.fromCodePoint(msg.text.codePointAt(last)!).length).trim();
      if (!HAS_WORD_CHAR.test(words)) { if (inOkSpan) sawOkOnly = true; continue; }
      return { ok: true, messageId: msg.id, sentAt: msg.sentAt, quote: words };
    }
  }
  return { ok: false, reason: sawOkOnly ? 'ok_only' : 'not_found' };
}

// --- Unit 2 rule 7 (decision 5): a go item needs a named approval ----------------------------

export const GO_APPROVAL_ERROR = "A go item needs its ID or the action word in the user's answer. A bare yes is not enough. Ask the user.";

const ACTION_WORD = /(?<![\p{L}\p{N}])(?:merge|deploy|release|push|restart|update)(?![\p{L}\p{N}])/iu;

/**
 * True when a quote (already past the rule-6 ok-word removal) names the go item it approves:
 * its ID (`N12`) or one of the action words, case-insensitive, as a whole word — so "emerged"
 * does not count as "merge", and "N123" does not count as "N12".
 */
export function namesGoApproval(quote: string, seq: number): boolean {
  const id = new RegExp(`(?<![\\p{L}\\p{N}])N${seq}(?![\\p{L}\\p{N}])`, 'iu');
  return id.test(quote) || ACTION_WORD.test(quote);
}
