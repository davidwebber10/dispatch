// packages/core/src/limits/detect.ts
// Reads the agent CLIs' usage-limit stops: which kind, and when the limit resets. Pure.

/** `session` = the 5-hour window, `weekly` = the 7-day window (incl. per-model), `usage` = any other. */
export type LimitKind = 'session' | 'weekly' | 'usage';

export interface UsageLimit {
  kind: LimitKind;
  /** Epoch ms of the reset, or null when the CLI gave no readable time. */
  resetsAt: number | null;
  /** The CLI's own words, kept for the record. */
  message: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_MS = 86_400_000;

/** The offset (ms) of `zone` from UTC at the instant `at`. */
function zoneOffset(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(at / 1000) * 1000;
}

/** The instant at which `zone`'s wall clock reads y-m-d h:mi (m is 0-based). */
function wallToEpoch(y: number, m: number, d: number, h: number, mi: number, zone: string | undefined): number {
  const asUtc = Date.UTC(y, m, d, h, mi);
  if (!zone) return asUtc + new Date(asUtc).getTimezoneOffset() * 60_000;
  const first = asUtc - zoneOffset(asUtc, zone);
  return asUtc - zoneOffset(first, zone);
}

/** The y/m/d/weekday of `at` on the wall clock of `zone` (undefined = this machine). */
function wallParts(at: number, zone: string | undefined): { y: number; m: number; d: number; dow: number } {
  const dt = new Date(at + (zone ? zoneOffset(at, zone) : -new Date(at).getTimezoneOffset() * 60_000));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), dow: dt.getUTCDay() };
}

function validZone(z: string | undefined): string | undefined {
  if (!z) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return undefined; }
}

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)`;
const ABSOLUTE = new RegExp(
  String.raw`(?:resets?|try again|available)\s*(?:at|on)?\s*(?:(${DAYS.join('|')})[a-z]*\.?,?\s+|(${MONTHS.join('|')})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?)?(?:at\s+)?${TIME}(?:\s*\(([A-Za-z_]+(?:/[A-Za-z_+\-0-9]+)*)\))?`,
  'i',
);
const RELATIVE = /try again in\s+(?:(\d+)\s*days?)?[\s,and]*(?:(\d+)\s*hours?)?[\s,and]*(?:(\d+)\s*(?:minutes?|mins?))?/i;

/**
 * The reset instant named in `text`: "resets 1:10am (America/Indianapolis)", "resets Oct 30, 9am",
 * "resets Mon 9:00am", "try again at Oct 29th, 2026 9:00 AM", "try again in 2 hours 5 minutes".
 * A time with no date is the next time the clock reads that, so one said at 11 PM for "1:10am"
 * is tomorrow. A weekday is the next such day. Null when the text has no readable time.
 */
export function parseResetTime(text: string, now: number): { at: number; zone?: string } | null {
  const rel = RELATIVE.exec(text);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    return { at: now + ((Number(rel[1] ?? 0) * 24 + Number(rel[2] ?? 0)) * 60 + Number(rel[3] ?? 0)) * 60_000 };
  }
  const m = ABSOLUTE.exec(text);
  if (!m) return null;
  const [, dayName, monName, monDay, year, hh, mm, ampm, rawZone] = m;
  const zone = validZone(rawZone);
  let hour = Number(hh) % 12;
  if (ampm.toLowerCase() === 'pm') hour += 12;
  const minute = Number(mm ?? 0);
  if (hour > 23 || minute > 59) return null;
  const today = wallParts(now, zone);
  let at: number;
  if (monName) {
    const mon = MONTHS.indexOf(monName.toLowerCase());
    const y = year ? Number(year) : today.y;
    at = wallToEpoch(y, mon, Number(monDay), hour, minute, zone);
    if (!year && at < now - DAY_MS) at = wallToEpoch(y + 1, mon, Number(monDay), hour, minute, zone);
  } else if (dayName) {
    let ahead = (DAYS.indexOf(dayName.toLowerCase()) - today.dow + 7) % 7;
    at = wallToEpoch(today.y, today.m, today.d + ahead, hour, minute, zone);
    if (at <= now) { ahead += 7; at = wallToEpoch(today.y, today.m, today.d + ahead, hour, minute, zone); }
  } else {
    at = wallToEpoch(today.y, today.m, today.d, hour, minute, zone);
    if (at <= now) at = wallToEpoch(today.y, today.m, today.d + 1, hour, minute, zone);
  }
  return { at, zone };
}

function kindFromType(t: unknown): LimitKind | null {
  if (typeof t !== 'string') return null;
  if (t === 'five_hour') return 'session';
  if (t.startsWith('seven_day')) return 'weekly';
  return 'usage';
}

function kindFromText(text: string): LimitKind {
  if (/weekly|7[- ]day|seven[- ]day|opus limit|sonnet limit/i.test(text)) return 'weekly';
  if (/session|5[- ]hour|five[- ]hour/i.test(text)) return 'session';
  return 'usage';
}

/** Claude Code's limit wording, with or without the "You've hit your" lead. */
const CLAUDE_LIMIT_TEXT = /(?:you['’]ve hit your|you have hit your)\s+[\w\s.-]*?limit|(?:session|weekly|usage|5-hour|opus)\s+limit reached|claude usage limit reached/i;

const frameText = (frame: any): string => {
  const parts = frame?.message?.content;
  if (Array.isArray(parts)) return parts.filter((b: any) => b?.type === 'text').map((b: any) => b.text ?? '').join('');
  return typeof frame?.result === 'string' ? frame.result : '';
};

/**
 * A Claude stream-json frame that says the account is out of quota. Three shapes, all seen or
 * documented: the synthetic assistant frame (`apiError: usage_limit_reached` + `quotaLimits`),
 * a `rate_limit_event` whose status is `rejected`, and the error `result`. The structured reset
 * (epoch seconds) wins over the text; ordinary prose that only quotes the words is not a limit.
 */
export function detectClaudeLimit(frame: any, now: number): UsageLimit | null {
  if (!frame || typeof frame !== 'object') return null;
  const text = frameText(frame);
  if (frame.type === 'rate_limit_event') {
    const info = frame.rate_limit_info ?? frame.rateLimitInfo;
    // Using overage or a fallback model means the CLI keeps going: not a stop.
    if (info?.status !== 'rejected' || info.isUsingOverage === true || info.unifiedRateLimitFallbackAvailable === true) return null;
    const secs = Number(info.resetsAt ?? info.resets_at);
    return { kind: kindFromType(info.rateLimitType ?? info.rate_limit_type) ?? 'usage', resetsAt: Number.isFinite(secs) && secs > 0 ? secs * 1000 : null, message: 'rate limit rejected' };
  }
  const synthetic = frame.type === 'assistant' && (frame.apiError === 'usage_limit_reached' || (frame.isApiErrorMessage === true && CLAUDE_LIMIT_TEXT.test(text)) || (frame.message?.model === '<synthetic>' && CLAUDE_LIMIT_TEXT.test(text)));
  const errorResult = frame.type === 'result' && frame.is_error === true && CLAUDE_LIMIT_TEXT.test(text);
  if (!synthetic && !errorResult) return null;
  const quota = frame.quotaLimits ?? frame.apiErrorParams?.rate_limit_info;
  const secs = Number(quota?.resetsAt);
  const resetsAt = Number.isFinite(secs) && secs > 0 ? secs * 1000 : (parseResetTime(text, now)?.at ?? null);
  return { kind: kindFromType(quota?.rateLimitType) ?? kindFromText(text), resetsAt, message: text.trim() || String(frame.apiError ?? 'usage limit reached') };
}

/**
 * A Codex turn error that is a usage or rate limit. `codexErrorInfo` (app-server `error`
 * notification) is the signal; without it the wording must say so.
 */
export function detectCodexLimit(err: { message?: string; codexErrorInfo?: unknown }, now: number): UsageLimit | null {
  const message = typeof err?.message === 'string' ? err.message : '';
  const info = err?.codexErrorInfo;
  const byInfo = info === 'usageLimitExceeded' || info === 'rateLimitExceeded';
  if (!byInfo && !(info == null && /hit your .*limit|usage limit/i.test(message))) return null;
  return { kind: kindFromText(message), resetsAt: parseResetTime(message, now)?.at ?? null, message: message.trim() || 'usage limit reached' };
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b\([A-Za-z]/g;
/** The exact banner Claude Code's screen shows: "You've hit your <kind> limit · resets <time>". */
const BANNER = /you['’]ve hit your\s+[\w\s.-]*?limit\s*[·∙•|-]\s*resets[^\r\n]*/i;

/** The Claude banner in CLI (PTY) output. Needs the "· resets" shape, so prose about limits is ignored. */
export function detectBannerLimit(output: string, now: number): UsageLimit | null {
  const m = BANNER.exec(output.replace(ANSI, ''));
  if (!m) return null;
  const message = m[0].trim();
  return { kind: kindFromText(message), resetsAt: parseResetTime(message, now)?.at ?? null, message };
}

const KIND_NAME: Record<LimitKind, string> = { session: 'session limit', weekly: 'weekly limit', usage: 'usage limit' };

/** "Paused: session limit, resumes 1:10 AM" (a later day names the weekday). */
export function pauseLabel(kind: LimitKind, resetsAt: number | null, now: number, zone?: string, fallbackMs?: number): string {
  const head = `Paused: ${KIND_NAME[kind]}`;
  if (resetsAt === null) {
    const mins = Math.round((fallbackMs ?? 0) / 60_000);
    return `${head}, reset time unknown, retrying in ${mins >= 120 && mins % 60 === 0 ? `${mins / 60} hours` : `${mins} minutes`}`;
  }
  const tz = validZone(zone);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(resetsAt));
  const soon = resetsAt - now < DAY_MS - 60_000;
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(resetsAt));
  return `${head}, resumes ${soon ? '' : `${day} `}${time}`;
}
