// Provider-agnostic cleanup of a finished transcript: drop standalone filler
// sounds (um, uh, er, ah, hmm and their stretched forms) and fix the spacing,
// punctuation and capitalization they leave behind.
//
// This is a word list only. It does not touch "like", "you know", stutters or
// repeated words. It is deliberately conservative: when a case is unclear, the
// text is left as it was.
//
// The work is one left-to-right pass: find the fillers, group the ones that sit
// side by side, and copy the text between them into one output. Every look
// behind a filler is capped at a few hundred characters, so the run time grows
// in step with the length of the text.

// Filler forms: um, umm / uh, uhh, uhm / er, erm / ah, ahh / hm, hmm, hmmm.
// "err" is NOT a form: it is a real word ("to err is human").
const FORMS = 'um+|uh+m?|erm?|ah+|hm+';

// A filler is a whole token. These characters on either side mean it is part
// of a longer word, a compound or code, so it stays: letters, digits, "_",
// apostrophes, "-" (uh-huh, mm-hmm), and code characters (um=1, um/uh, um@x).
// A dot or colon counts too when a letter or digit follows it (um.txt), but
// not at the end of a sentence ("Friday, um."). "uh huh" is an answer, so a
// following "huh" also protects the filler, with or without a comma.
const NOT_BESIDE = "\\p{L}\\p{N}_'’\\-=/\\\\@#$%&*+<>~|^";
const FILLER_RE = new RegExp(
  `(?<![${NOT_BESIDE}.:])(${FORMS})(?![${NOT_BESIDE}]|[.:][\\p{L}\\p{N}])(?![ \\t]*,?[ \\t]*huh\\b)`,
  'giu',
);
const FILLER_AT_END_RE = new RegExp(`(?<![\\p{L}\\p{N}_'’\\-])(?:${FORMS})$`, 'iu');
const FILLER_COMMA_AT_END_RE = new RegExp(`(?<![\\p{L}\\p{N}_'’\\-])(?:${FORMS}),$`, 'iu');

// A quote, bracket, backtick or dash touching the filler on either side means
// the text is quoted, wrapped or part of a phrase. Leave it as it is.
const PROTECT_BESIDE = '"\u201C\u201D\u2018\u2019\'`([{)]}\u2014\u2013';
const LOOKBACK = 200;

// First words of a sentence that normally keep a comma after them ("So, I...").
const DISCOURSE = new Set([
  'so', 'well', 'now', 'okay', 'ok', 'alright', 'yes', 'yeah', 'no', 'right', 'actually',
  'anyway', 'basically', 'honestly', 'however', 'first', 'then', 'also', 'look', 'listen',
  'sure', 'oh', 'wait', 'hi', 'hello', 'thanks',
]);
// Dotted forms that end in a full stop without ending the sentence.
const ABBREVIATIONS = new Set(['mr.', 'mrs.', 'ms.', 'dr.', 'st.', 'prof.', 'jr.', 'sr.', 'vs.']);

const isHs = (c: string | undefined) => c === ' ' || c === '\t';
const isWs = (c: string | undefined) => c !== undefined && c !== '' && /\s/.test(c);
const isStop = (c: string | undefined) => c === '.' || c === '!' || c === '?' || c === '…';

interface Hit { start: number; end: number; }

// Remove standalone filler sounds from English text. Returns the same string
// when there is nothing to remove.
export function removeFillers(text: string): string {
  if (!text) return text;
  const hits = findHits(text);
  if (hits.length === 0) return text;

  // Fillers with only spaces and one comma between them go together.
  const clusters: Hit[] = [];
  for (const h of hits) {
    const last = clusters[clusters.length - 1];
    if (last && /^[ \t]*[,;]?[ \t]*$/.test(text.slice(last.end, h.start))) last.end = h.end;
    else clusters.push({ start: h.start, end: h.end });
  }

  const out: string[] = [];
  let lastEmitted = '';
  // Work waiting for the next piece of copied text.
  let wantSpace = false;
  let wantCapital = false;
  let skipSpaces = false;

  const push = (piece: string) => {
    out.push(piece);
    lastEmitted = piece[piece.length - 1];
  };
  const emit = (raw: string) => {
    let piece = raw;
    if (skipSpaces) {
      let k = 0;
      while (k < piece.length && isHs(piece[k])) k++;
      piece = piece.slice(k);
    }
    if (!piece) return; // nothing to copy yet: the pending work stays
    skipSpaces = false;
    if (wantSpace) {
      wantSpace = false;
      if (lastEmitted && !isWs(lastEmitted) && !isWs(piece[0]) && !/[,.;:!?…)\]}]/.test(piece[0])) push(' ');
    }
    if (wantCapital) {
      wantCapital = false;
      piece = capitalizeFirstWord(piece);
    }
    push(piece);
  };

  let cursor = 0;
  for (const c of clusters) {
    const back = lookBack(text, c.start, cursor);
    emit(text.slice(cursor, back.headEnd));
    const ahead = lookAhead(text, c.end);
    const firstIsCapital = /^\p{Lu}/u.test(text.slice(c.start, c.start + 1));

    if (back.sentenceStart) {
      // The filler opens a sentence: drop it, and the next word opens the sentence.
      // After a line break the copied text already ends with the break.
      wantSpace = !back.hasNewline;
      skipSpaces = true;
      wantCapital = back.hasContent || firstIsCapital;
    } else {
      let keepComma = false;
      if (back.commaBefore && ahead.punct !== '' && ahead.punct !== ',') {
        keepComma = false; // a stop or colon follows: it replaces the comma
      } else if (back.commaBefore) {
        keepComma = (startsSentence(text, lastWordStart(text, back.headEnd)) && DISCOURSE.has(lastWord(text, back.headEnd)))
          || isListComma(text, back.headEnd);
        if (keepComma && lineEndsAt(text, ahead.tailStart)) keepComma = false;
      }
      if (ahead.punct !== '' && ahead.punct !== ',') push(ahead.punct);
      else { if (keepComma) push(','); wantSpace = true; }
    }
    cursor = ahead.tailStart;
  }
  emit(text.slice(cursor));
  return out.join('');
}

// Find every filler that is safe to remove.
function findHits(s: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of s.matchAll(FILLER_RE)) {
    const token = m[1];
    const start = m.index!;
    const end = start + m[0].length;
    if (PROTECT_BESIDE.includes(s[start - 1] ?? '\u0000') || PROTECT_BESIDE.includes(s[end] ?? '\u0000')) continue;
    // A short all-caps token is usually an acronym (ER, UM).
    if (token.length < 3 && token === token.toUpperCase()) continue;
    // A capitalized filler in the middle of a sentence is likely a name (Um Kulthum).
    const isCapitalized = token === token[0].toUpperCase() + token.slice(1).toLowerCase();
    if (isCapitalized && !opensClause(s, start, hits[hits.length - 1])) continue;
    hits.push({ start, end });
  }
  return hits;
}

// True when a filler stands where a sentence, or a soft restart after an
// ellipsis, begins, or when it follows another removable filler.
function opensClause(s: string, start: number, prev?: Hit): boolean {
  if (prev && /^[ \t]*[,;]?[ \t]*$/.test(s.slice(prev.end, start))) return true;
  const b = lookBack(s, start, 0);
  return b.sentenceStart || b.softStart;
}

interface Back {
  headEnd: number;      // end of the kept text before the filler
  commaBefore: boolean; // a comma sat directly before the filler
  hasNewline: boolean;  // a line break separates the kept text from the filler
  hasContent: boolean;  // there is text before the filler
  sentenceStart: boolean;
  softStart: boolean;   // after an ellipsis
}

function lookBack(s: string, start: number, floor: number): Back {
  let p = start;
  while (p > floor && isHs(s[p - 1])) p--;
  let commaBefore = false;
  if (p > floor && s[p - 1] === ',') {
    commaBefore = true;
    p--;
    while (p > floor && isHs(s[p - 1])) p--;
  }
  const headEnd = p;
  let r = headEnd;
  let hasNewline = false;
  while (r > 0 && isWs(s[r - 1])) { if (s[r - 1] === '\n') hasNewline = true; r--; }
  const hasContent = r > 0;
  const lastCh = hasContent ? s[r - 1] : '';
  const soft = lastCh === '…' || s.slice(Math.max(0, r - 3), r) === '...';
  const abbreviation = lastCh === '.' && isAbbreviation(lastWordBefore(s, r));
  const sentenceStart = !hasContent || hasNewline
    || (!soft && !abbreviation && (lastCh === '.' || lastCh === '!' || lastCh === '?'));
  return {
    headEnd, commaBefore, hasContent, hasNewline, sentenceStart, softStart: soft,
  };
}

function lastWordBefore(s: string, end: number): string {
  let k = end;
  const lim = Math.max(0, end - 24);
  while (k > lim && !isWs(s[k - 1])) k--;
  return s.slice(k, end).toLowerCase();
}

function isAbbreviation(word: string): boolean {
  return /^(?:[a-z]\.){2,}$/.test(word) || ABBREVIATIONS.has(word);
}

interface Ahead {
  punct: string;     // one comma, semicolon or colon, or a run of stops, right after the filler ('' if none)
  tailStart: number; // where the copied text resumes
}

function lookAhead(s: string, end: number): Ahead {
  let q = end;
  while (q < s.length && isHs(s[q])) q++;
  const c = s[q];
  if (c === ',' || c === ';' || c === ':') return { punct: c, tailStart: q + 1 };
  if (isStop(c)) {
    let e = q;
    while (e < s.length && isStop(s[e])) e++;
    return { punct: s.slice(q, e), tailStart: e };
  }
  return { punct: '', tailStart: q };
}

function lineEndsAt(s: string, from: number): boolean {
  let q = from;
  while (q < s.length && isHs(s[q])) q++;
  return q >= s.length || s[q] === '\n' || s[q] === '\r';
}

function lastWordStart(s: string, end: number): number {
  let k = end;
  const lim = Math.max(0, end - 40);
  while (k > lim && !isWs(s[k - 1])) k--;
  return k;
}

function lastWord(s: string, end: number): string {
  return s.slice(lastWordStart(s, end), end).toLowerCase().replace(/[^a-z]/g, '');
}

// Does the word that starts at k open its sentence? A filler plus a comma in
// front of it ("Ah, wait") does not count against it.
function startsSentence(s: string, from: number): boolean {
  let k = from;
  for (let guard = 0; guard < LOOKBACK; guard++) {
    let r = k;
    while (r > 0 && isWs(s[r - 1])) r--;
    if (r === 0) return true;
    if (s.slice(r, k).includes('\n')) return true;
    const c = s[r - 1];
    if (c === '.' || c === '!' || c === '?') return true;
    if (c !== ',') return false;
    const from0 = Math.max(0, r - 24);
    const m = FILLER_COMMA_AT_END_RE.exec(s.slice(from0, r));
    if (!m) return false;
    k = r - m[0].length;
  }
  return false;
}

// "one, two, um, three": the comma before the filler belongs to a list. It is
// kept when an earlier real comma in the same sentence sits one word back.
// A comma that follows a removed filler does not count.
function isListComma(s: string, headEnd: number): boolean {
  const lim = Math.max(0, headEnd - LOOKBACK);
  let p = headEnd - 1;
  while (p >= lim && s[p] !== ',' && !isStop(s[p]) && s[p] !== '\n') p--;
  if (p < lim || s[p] !== ',') return false;
  const segment = s.slice(p + 1, headEnd).trim();
  if (!segment || /\s/.test(segment)) return false;
  const before = s.slice(Math.max(0, p - 24), p).trimEnd();
  return !FILLER_AT_END_RE.test(before);
}

// Capitalize the first word only when it is plain lowercase letters. Paths,
// identifiers, camelCase and numbers are left as spoken.
function capitalizeFirstWord(rest: string): string {
  const w = /^[^\s,;:!?]+/.exec(rest);
  // A stop right after the word ("wait.") is sentence punctuation, not part of
  // the word. A dot inside it ("package.json") is, so that word is left alone.
  if (!w || !/^[a-z]+$/.test(w[0].replace(/[.…]+$/, ''))) return rest;
  return rest[0].toUpperCase() + rest.slice(1);
}

// The word list is English only. "er" is "he" in German and "um" is "at" or
// "around", so a transcript is cleaned only when the provider reports English.
// When the provider reports no language, English asked for by the caller is
// enough. With neither, the text is left alone.
export function shouldCleanLanguage(requested?: string, detected?: string): boolean {
  const isEnglish = (l: string) => /^(en|eng)($|[-_])|^english/i.test(l);
  // A caller who asked for another language wins over what the provider reports.
  if (requested && !isEnglish(requested)) return false;
  if (detected) return isEnglish(detected);
  return !!requested;
}
