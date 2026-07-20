/**
 * Does this turn end by asking the human for something?
 *
 * The backstop for when an agent doesn't call `report_status`. Claude Code's turn-end
 * `result` event carries no indication of intent, so without this a turn ending
 * "…does that look right?" is indistinguishable from one that finished the job.
 *
 * Deliberately checks only the CLOSING sentence, not the whole message: models pose
 * rhetorical questions mid-explanation constantly ("Why does this fail? Because…"),
 * and treating those as asks would flood the needs-help state with false positives.
 * What matters is how the turn was left.
 *
 * Never used when the agent declared its state — declaration always wins.
 */

// Fenced code blocks routinely contain question marks in strings and comments; strip
// them before looking at the prose so `throw new Error("who?")` isn't read as an ask.
// The `(?:```|$)` alternative also tolerates an unterminated block — a message
// truncated mid-code-fence still gets its fence content stripped instead of leaking
// into the closing-thought check.
const FENCE = /```[\s\S]*?(?:```|$)/g;

// Phrasings that hand the decision back without necessarily using a question mark.
// Kept deliberately narrow: under-detection is the safe direction here (see module
// doc), so every entry should be unambiguously addressed to the human, not just a
// word that happens to co-occur with asks. Bare "confirm", for example, matches
// ordinary completion reports ("Logs confirm the deploy succeeded.") — a genuine
// confirm-ask almost always ends in "?" anyway, which the question-mark rule already
// covers, so narrowing it costs almost no real detection.
const ASK_PHRASES = [
  /\blet me know\b/i,
  /\bwhich (one )?(would you|do you)\b/i,
  /\bdo you want\b/i,
  /\bwould you (like|prefer)\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\b(please confirm|can you confirm|could you confirm|confirm that you)\b/i,
  /\byour call\b/i,
  /\bup to you\b/i,
  /\bi need (the|your|a)\b/i,
  /\bwaiting (on|for) you\b/i,
];

export function looksLikeQuestion(text: string): boolean {
  const prose = (text ?? '').replace(FENCE, ' ').trim();
  if (!prose) return false;

  // Isolate the closing thought by LINE first, then by sentence within that line.
  // Agent output is frequently a bullet list with no terminal punctuation at all, in
  // which case sentence-splitting alone treats the whole message as one "sentence"
  // and lets an early bullet's phrasing leak into the check. Line-splitting first
  // finds the actual last line said; sentence-splitting within it then finds the
  // actual last thought, for normal multi-sentence prose on that line.
  const lines = prose.split('\n').map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? '';

  const sentences = lastLine.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const last = sentences[sentences.length - 1] ?? '';

  if (last.endsWith('?')) return true;
  return ASK_PHRASES.some((re) => re.test(last));
}
