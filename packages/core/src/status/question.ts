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
const FENCE = /```[\s\S]*?```/g;

// Phrasings that hand the decision back without necessarily using a question mark.
const ASK_PHRASES = [
  /\blet me know\b/i,
  /\bwhich (one )?(would you|do you)\b/i,
  /\bdo you want\b/i,
  /\bwould you (like|prefer)\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bconfirm\b/i,
  /\byour call\b/i,
  /\bup to you\b/i,
  /\bi need (the|your|a)\b/i,
  /\bwaiting (on|for) you\b/i,
];

export function looksLikeQuestion(text: string): boolean {
  const prose = (text ?? '').replace(FENCE, ' ').trim();
  if (!prose) return false;

  // The closing sentence — split on terminators, keep the last non-empty fragment.
  const sentences = prose.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const last = sentences[sentences.length - 1] ?? '';
  if (!last) return false;

  if (last.endsWith('?')) return true;
  return ASK_PHRASES.some((re) => re.test(last));
}
