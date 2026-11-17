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
  `(?<![${NOT_BESIDE}.:])(${FORMS})(?![${NOT_BESIDE}]|[.:][\\p{L}\\p{N}])(?![ \\t]*(?:,[ \\t]*)?huh\\b)`,
  'giu',
);

// A quote, bracket, backtick or dash touching the filler on either side means
// the text is quoted, wrapped or part of a phrase. Leave it as it is.
const PROTECT_BESIDE = '"\u201C\u201D\u2018\u2019\'`([{)]}\u2014\u2013';
const WRAP_OPEN = '([{`"\u201C\u2018\'\u2014\u2013-';
const WRAP_CLOSE = ')]}`"\u201D\u2019\'\u2014\u2013-';

// A comma in front of a filler stays, so "Actually, um, no" keeps "Actually, no"
// and "John, uh, call me" keeps "John, call me". It goes only after these words,
// where a comma would split a phrase ("port to, um, 4000" gives "port to 4000").
const DROP_COMMA_AFTER = new Set(['to', 'the', 'a', 'of']);
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
    if (last && isJoinGap(text, last.end, h.start)) last.end = h.end;
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
    // A piece of only whitespace keeps the capital waiting for real text.
    if (wantCapital && piece.trim() !== '') {
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
        keepComma = !DROP_COMMA_AFTER.has(lastWord(text, back.headEnd)) && !lineEndsAt(text, ahead.tailStart);
      }
      if (ahead.punct !== '' && ahead.punct !== ',') {
        // The filler ended a sentence. Keep that stop unless the kept text
        // already ends in one ("I was... uh... thinking" keeps one ellipsis).
        // Only a stop made of dots adds nothing after a stop. A "?" or "!" does.
        if (!(isStop(lastStop(text, back.headEnd)) && /^[.…]+$/.test(ahead.punct))) {
          push(ahead.punct);
          // A full stop, ! or ? starts a new sentence; an ellipsis does not.
          if (/[.!?]$/.test(ahead.punct) && !/\.{3}$|\u2026$/.test(ahead.punct)) wantCapital = true;
        }
        wantSpace = true;
      } else {
        if (keepComma) push(',');
        // One space joins the two sides, whatever space the text had.
        wantSpace = true;
        skipSpaces = true;
      }
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
    // Wrapped with spaces inside: ( um ), "um", one - um - two.
    if (WRAP_OPEN.includes(nearLeft(s, start) || '\u0000') && WRAP_CLOSE.includes(nearRight(s, end) || '\u0000')) continue;
    // A short all-caps token is usually an acronym (ER, UM).
    if (token.length < 3 && token === token.toUpperCase()) continue;
    // A capitalized filler in the middle of a sentence is likely a name (Um Kulthum).
    const isCapitalized = token === token[0].toUpperCase() + token.slice(1).toLowerCase();
    if (isCapitalized && !opensClause(s, start, end, hits[hits.length - 1])) continue;
    hits.push({ start, end });
  }
  return hits;
}

// True when a filler stands where a sentence, or a soft restart after an
// ellipsis, begins, or when it follows another removable filler.
function opensClause(s: string, start: number, end: number, prev?: Hit): boolean {
  if (prev && isJoinGap(s, prev.end, start)) return true;
  const b = lookBack(s, start, 0);
  if (b.sentenceStart || b.softStart) return true;
  // After p.m. or U.S., a capital filler that is followed by a comma or a stop
  // is a pause ("p.m. Um, then"), not a name ("Dr. Um Kulthum").
  return b.afterAbbreviation && /[,.!?…]/.test(nearRight(s, end) || ' ');
}

// True when only spaces, tabs and at most one comma or semicolon lie between
// two fillers, so they go as one group. A long gap never qualifies, which keeps
// the check constant-time however much whitespace the text holds.
function isJoinGap(s: string, from: number, to: number): boolean {
  if (to - from > 40) return false;
  let marks = 0;
  for (let i = from; i < to; i++) {
    const c = s[i];
    if (c === ',' || c === ';') { if (++marks > 1) return false; }
    else if (!isHs(c)) return false;
  }
  return true;
}

// The nearest character that is not a space or tab, looking left or right
// (a short distance only). '' when none is near or at the edge of the text.
function nearLeft(s: string, from: number): string {
  let i = from - 1;
  for (let n = 0; i >= 0 && isHs(s[i]) && n < 40; n++) i--;
  return i >= 0 && !isHs(s[i]) ? s[i] : '';
}
function nearRight(s: string, from: number): string {
  let i = from;
  for (let n = 0; i < s.length && isHs(s[i]) && n < 40; n++) i++;
  return i < s.length && !isHs(s[i]) ? s[i] : '';
}

interface Back {
  headEnd: number;      // end of the kept text before the filler
  commaBefore: boolean; // a comma sat directly before the filler
  hasNewline: boolean;  // a line break separates the kept text from the filler
  hasContent: boolean;  // there is text before the filler
  sentenceStart: boolean;
  softStart: boolean;   // after an ellipsis
  afterAbbreviation: boolean; // after p.m., U.S., Dr. and the like
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
  const lastWordHere = lastCh === '.' ? lastWordBefore(s, r) : '';
  const abbreviation = lastCh === '.' && isAbbreviation(lastWordHere);
  const dottedAbbreviation = abbreviation && /^(?:[a-z]\.){2,}$/.test(lastWordHere);
  const sentenceStart = !hasContent || hasNewline
    || (!soft && !abbreviation && (lastCh === '.' || lastCh === '!' || lastCh === '?'));
  return {
    headEnd, commaBefore, hasContent, hasNewline, sentenceStart, softStart: soft, afterAbbreviation: dottedAbbreviation,
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

// The last character before a position, ignoring spaces and tabs.
function lastStop(s: string, end: number): string {
  let i = end - 1;
  while (i >= 0 && isHs(s[i])) i--;
  return i >= 0 ? s[i] : '';
}

function lineEndsAt(s: string, from: number): boolean {
  let q = from;
  while (q < s.length && isHs(s[q])) q++;
  return q >= s.length || s[q] === '\n' || s[q] === '\r';
}

// The word that ends at a position, lowercased, letters only.
function lastWord(s: string, end: number): string {
  let k = end;
  const lim = Math.max(0, end - 40);
  while (k > lim && !isWs(s[k - 1])) k--;
  return s.slice(k, end).toLowerCase().replace(/[^a-z]/g, '');
}

// Capitalize the first word only when it is plain lowercase letters. Paths,
// identifiers, camelCase and numbers are left as spoken.
function capitalizeFirstWord(text: string): string {
  let lead = 0;
  while (lead < text.length && isWs(text[lead])) lead++;
  const rest = text.slice(lead);
  const w = /^[^\s,;:!?]+/.exec(rest);
  // A stop right after the word ("wait.") is sentence punctuation, not part of
  // the word. A dot inside it ("package.json") is, so that word is left alone.
  if (!w || !/^[a-z]+$/.test(w[0].replace(/[.…]+$/, ''))) return text;
  return text.slice(0, lead) + rest[0].toUpperCase() + rest.slice(1);
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
