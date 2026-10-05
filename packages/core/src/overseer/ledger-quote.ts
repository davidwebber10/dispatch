/**
 * The ledger's quote check (structured-recap spec, Unit 2 rules 2 and 6). Pure: it takes the
 * overseer's logged messages and decides whether the user really wrote the quoted words.
 *
 * - The match ignores case and runs of white space.
 * - Only `user` messages count; `canned`, `coordinator` and `daemon` messages never match.
 * - With `after`, only messages sent strictly after that time count.
 * - The earliest matching message wins.
 * - A leading ok-word (ok, okay, k, kk — any case, then any punctuation and spaces) is removed
 *   from the quote when the match starts at the beginning of the message. If nothing remains,
 *   the check fails as `ok_only`. An "ok" in the middle of a message is never removed.
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
  let sawOkOnly = false;
  for (const msg of candidates) {
    const { norm, map } = normalizeWithMap(msg.text);
    const lead = norm.startsWith(' ') ? 1 : 0; // leading white space does not move "the start"
    for (let at = norm.indexOf(needle); at !== -1; at = norm.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      const okWord = at === lead ? needle.match(OK_PREFIX) : null;
      const start = okWord ? at + okWord[0].length : at;
      if (start >= end) { sawOkOnly = true; continue; }
      const last = map[end - 1];
      const words = msg.text.slice(map[start], last + String.fromCodePoint(msg.text.codePointAt(last)!).length).trim();
      if (!words) { sawOkOnly = true; continue; }
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
