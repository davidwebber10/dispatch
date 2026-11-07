// Coach cadence (coach spec section 4.3; plan Task 10): when a card or the recap may show. Pure
// functions over the `cadence` document; the web part saves what they return.
//
// The document: { day, shownToday, shownThisSession, lastShownAt, mutedUntil, restUntilByType,
// dismissCount, firstSeenAt, welcomeSeenAt, welcomeDone }.

/** Cards a day per level (Settings → Coach → How often). */
export const LEVEL_CAP = Object.freeze({ off: 0, quiet: 0, normal: 3, chatty: 8 });
export const REST_DAYS = 14;
/** A session ends after this long with no card shown. */
export const SESSION_GAP_MS = 2 * 3600_000;
export const FIRST_WEEK_MS = 7 * 86400_000;
const FOREVER = '9999-12-31T23:59:59.999Z';
const DAY_MS = 86400_000;

const toMs = (now) => (now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : Number(now));
const pad = (n) => String(n).padStart(2, '0');
/** The local calendar day, YYYY-MM-DD. */
export const dayKey = (now) => { const d = new Date(toMs(now)); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export function emptyCadence(now) {
  return { day: null, shownToday: 0, shownThisSession: 0, lastShownAt: null, mutedUntil: null, restUntilByType: {}, dismissCount: {}, firstSeenAt: new Date(toMs(now)).toISOString(), welcomeDone: false };
}

export function isMuted(state, now) {
  return !!(state && state.mutedUntil && Date.parse(state.mutedUntil) > toMs(now));
}

/** True when the muting lasts until the person turns the coach back on. */
export const mutedForever = (state) => !!(state && state.mutedUntil === FOREVER);

const minutes = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
/** Quiet hours `{ from, to }` in local time; a range that wraps midnight works. */
export function inQuietHours(quiet, now) {
  if (!quiet) return false;
  const from = minutes(quiet.from); const to = minutes(quiet.to);
  if (from === null || to === null || from === to) return false;
  const d = new Date(toMs(now));
  const m = d.getHours() * 60 + d.getMinutes();
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/**
 * May a card (or the recap) show now? `opts.type` is the card's tip type (for rests), `opts.phone`
 * says the screen is a phone, `opts.welcome` marks the first-week welcome card.
 */
export function mayShow(state, settings, now, kind, opts = {}) {
  const st = state || {};
  const t = toMs(now);
  if (!settings || settings.howOften === 'off') return false;
  if (isMuted(st, t) || inQuietHours(settings.quietHours, t)) return false;
  if (kind === 'recap') return !(settings.recap && settings.recap.inApp === false);
  if (kind !== 'card') return false;
  const levelCap = LEVEL_CAP[settings.howOften] ?? LEVEL_CAP.normal;
  if (levelCap === 0) return false;
  const firstWeek = st.firstSeenAt ? t - Date.parse(st.firstSeenAt) < FIRST_WEEK_MS : true;
  // The welcome card ignores the phone setting: a person who uses only a phone must meet the Coach too.
  if (opts.welcome) return firstWeek && !st.welcomeDone;
  if (opts.phone && !settings.phone) return false;
  if (firstWeek) return false;
  if (opts.type && st.restUntilByType && st.restUntilByType[opts.type] && Date.parse(st.restUntilByType[opts.type]) > t) return false;
  const cap = Math.min(levelCap, typeof settings.maxPerDay === 'number' ? settings.maxPerDay : levelCap);
  const today = st.day === dayKey(t) ? st.shownToday || 0 : 0;
  if (today >= cap) return false;
  const sameSession = st.lastShownAt && t - Date.parse(st.lastShownAt) < SESSION_GAP_MS;
  const session = sameSession ? st.shownThisSession || 0 : 0;
  return session < (typeof settings.maxPerSession === 'number' ? settings.maxPerSession : 1);
}

/**
 * May the worker spend usage on a model call now (review finding 5)? Not before the person has
 * seen the welcome card and the first week has passed (rules still collect, at no cost), not
 * during a mute or quiet hours, and not with the Coach off.
 */
export function mayCallModel(state, settings, now) {
  const st = state || {};
  const t = toMs(now);
  if (settings && settings.howOften === 'off') return false;
  if (!st.firstSeenAt || t - Date.parse(st.firstSeenAt) < FIRST_WEEK_MS) return false;
  if (!st.welcomeSeenAt && !st.welcomeDone) return false;
  if (isMuted(st, t) || inQuietHours(settings && settings.quietHours, t)) return false;
  return true;
}

/** A card older than this many hours is no longer "what you just did": it does not show. */
export const CARD_MAX_AGE_HOURS = 48;
/** True when a card is too old to show (`settings.advanced.maxCardAgeHours`, default 48). */
export function isStale(card, settings, now) {
  const hours = settings && settings.advanced && typeof settings.advanced.maxCardAgeHours === 'number' ? settings.advanced.maxCardAgeHours : CARD_MAX_AGE_HOURS;
  const at = card && card.at ? Date.parse(card.at) : NaN;
  return Number.isFinite(at) && toMs(now) - at > hours * 3600_000;
}

/** Count a card that just showed. */
export function noteShown(state, now) {
  const st = state || {};
  const t = toMs(now);
  const day = dayKey(t);
  const sameSession = st.lastShownAt && t - Date.parse(st.lastShownAt) < SESSION_GAP_MS;
  return { ...st, day, shownToday: (st.day === day ? st.shownToday || 0 : 0) + 1, shownThisSession: (sameSession ? st.shownThisSession || 0 : 0) + 1, lastShownAt: new Date(t).toISOString() };
}

/** ✕ on a card: only "not now". The second dismissal of a type rests it 2 weeks; from the third, offer to turn it off. */
export function dismiss(state, type, now) {
  const st = state || {};
  const count = ((st.dismissCount && st.dismissCount[type]) || 0) + 1;
  const next = { ...st, dismissCount: { ...(st.dismissCount || {}), [type]: count }, restUntilByType: { ...(st.restUntilByType || {}) } };
  if (count === 2) next.restUntilByType[type] = new Date(toMs(now) + REST_DAYS * DAY_MS).toISOString();
  return { state: next, offerTurnOff: count >= 3 };
}

/** Mute for an hour, for the rest of today (local midnight), or until the person turns it on. */
export function mute(state, how, now) {
  const t = toMs(now);
  let until;
  if (how === 'hour') until = new Date(t + 3600_000).toISOString();
  else if (how === 'today') { const d = new Date(t); until = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString(); }
  else until = FOREVER;
  return { ...(state || {}), mutedUntil: until };
}

export function unmute(state) {
  return { ...(state || {}), mutedUntil: null };
}
