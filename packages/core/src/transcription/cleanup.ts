// Provider-agnostic cleanup of a finished transcript: drop standalone filler
// sounds (um, uh, er, ah, hmm and their stretched forms) and fix the spacing,
// punctuation and capitalization they leave behind.
//
// This is a word list only. It does not touch "like", "you know", stutters or
// repeated words. It is deliberately conservative: when a case is unclear, the
// text is left as it was.

// Filler forms: um, umm / uh, uhh, uhm / er, erm / ah, ahh / hm, hmm, hmmm.
// "err" is NOT a form: it is a real word ("to err is human").
const FORMS = 'um+|uh+m?|erm?|ah+|hm+';

// A filler is a whole token. A letter, digit, underscore, apostrophe or hyphen
// on either side means it is part of a longer word or compound (umbrella,
// uh-huh, uh-oh, mm-hmm, um-lang, um's), so it stays. "uh huh" is an answer,
// not a filler, so a following "huh" also protects it.
const FILLER_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_'’-])(${FORMS})(?![\\p{L}\\p{N}_'’-])(?!\\s+huh\\b)`,
  'giu',
);

const QUOTES = '"“”‘’\'';
const TERMINATORS = /[.!?…]$/;
const OPENER_TAIL = /(?:^|[.!?…]\s+|\n)\S+$/;

// Remove standalone filler sounds from English text. Returns the same string
// when there is nothing to remove.
export function removeFillers(text: string): string {
  if (!text) return text;
  let s = text;
  FILLER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // Each edit only shortens the string, so the loop ends. A guard caps the
  // count anyway, so a pathological input cannot spin.
  for (let guard = 0; guard < 10000 && (m = FILLER_RE.exec(s)); guard++) {
    const token = m[1];
    const start = m.index;
    const end = start + m[0].length;

    // Ambiguous: a filler touching a quote mark ("Ah, I see." or "um").
    if (start > 0 && QUOTES.includes(s[start - 1])) continue;
    // Ambiguous: a short all-caps token is usually an acronym (ER, UM).
    if (token.length < 3 && token === token.toUpperCase()) continue;

    const before = s.slice(0, start);
    const after = s.slice(end);

    // Spaces and one comma directly before the filler.
    const pre = /(,)?[ \t]*$/.exec(before)!;
    const commaBefore = !!pre[1];
    const head = before.slice(0, pre.index);
    // One comma, or one run of sentence punctuation, directly after it.
    const suf = /^[ \t]*([,;:]|[.!?…]+)?/.exec(after)!;
    const punct = suf[1] ?? '';
    const tail = after.slice(suf[0].length);

    const headTrim = head.trimEnd();
    const sentenceStart = headTrim === '' || TERMINATORS.test(headTrim) || /\n\s*$/.test(head);
    const wasCapital = token[0] !== token[0].toLowerCase();
    const sep = (rest: string) => (head && !/\s$/.test(head) && rest && !/^\s/.test(rest) ? ' ' : '');

    let out: string;
    let resume: number;
    if (sentenceStart) {
      const sentenceEndsHere = /^[.!?…]+$/.test(punct);
      let rest = tail.trimStart();
      if (!sentenceEndsHere && (wasCapital || headTrim !== '')) rest = capitalizeFirstWord(rest);
      out = head + (head && !/\s$/.test(head) && rest ? ' ' : '') + rest;
      resume = head.length;
    } else if (punct === ',') {
      // "X, um, Y": keep one comma only when X opens the sentence ("So, Y").
      const keep = commaBefore && OPENER_TAIL.test(head);
      const sp = /^\s/.test(tail) || tail === '' ? '' : ' ';
      out = head + (keep ? ',' : '') + sp + tail;
      resume = head.length;
    } else if (punct !== '') {
      // "X, um." or "X um;": the stop stays, the comma before the filler goes.
      out = head + punct + tail;
      resume = head.length;
    } else {
      out = head + (commaBefore ? ',' : '') + sep(tail) + tail;
      resume = head.length;
    }
    s = out;
    FILLER_RE.lastIndex = Math.max(0, resume);
  }
  return s;
}

// Capitalize the first word only when it is plain lowercase letters. Paths,
// identifiers, camelCase and numbers are left as spoken.
function capitalizeFirstWord(rest: string): string {
  const w = /^[^\s,;:!?]+/.exec(rest);
  // A stop right after the word ("wait.") is sentence punctuation, not part of
  // the word. A dot inside it ("package.json") is, so that word is left alone.
  if (!w || !/^[a-z]+$/.test(w[0].replace(/[.\u2026]+$/, ''))) return rest;
  return rest[0].toUpperCase() + rest.slice(1);
}

// The word list is English only. "er" is "he" in German and "um" is "at" or
// "around", so any non-English language skips the cleanup. An unknown language
// (no hint from the caller, none reported by the provider) is treated as
// English.
export function shouldCleanLanguage(requested?: string, detected?: string): boolean {
  const isEnglish = (l?: string) => !l || /^(en($|[-_])|english)/i.test(l);
  return isEnglish(requested) && isEnglish(detected);
}
