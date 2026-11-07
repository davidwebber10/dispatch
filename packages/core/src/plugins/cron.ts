/**
 * The cron subset plugin jobs use (plugins slice 5): five fields `min hour dom mon dow`, each
 * `*`, a number, a range `a-b`, a list `a,b`, or a step `*\/n` / `a-b/n`. Day-of-week 0 and 7
 * are Sunday. Evaluated in local time, to the minute. A job runs when the minute matches; a
 * minute missed while the daemon was down is not replayed.
 */
export interface CronSpec { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean }

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(field: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    let a: number; let b: number;
    if (m[1] === '*') { a = lo; b = hi; }
    else { a = Number(m[2]); b = m[3] !== undefined ? Number(m[3]) : a; }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b || step < 1) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const s = parseField(fields[i], RANGES[i][0], RANGES[i][1]);
    if (!s) return null;
    sets.push(s);
  }
  const dow = sets[4];
  if (dow.has(7)) { dow.add(0); dow.delete(7); }
  return { min: sets[0], hour: sets[1], dom: sets[2], mon: sets[3], dow, domAny: fields[2] === '*', dowAny: fields[4] === '*' };
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.min.has(date.getMinutes()) || !spec.hour.has(date.getHours()) || !spec.mon.has(date.getMonth() + 1)) return false;
  const domOk = spec.dom.has(date.getDate());
  const dowOk = spec.dow.has(date.getDay());
  // Vixie cron: when both day fields are restricted, either one matching is enough.
  if (!spec.domAny && !spec.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

/** The next matching minute strictly after `from`, or null when none within 366 days. */
export function nextCronRun(spec: CronSpec, from: Date): Date | null {
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 3600 * 1000;
  while (t.getTime() <= limit) {
    if (!spec.mon.has(t.getMonth() + 1)) { t.setMonth(t.getMonth() + 1, 1); t.setHours(0, 0, 0, 0); continue; }
    const dayOk = (!spec.domAny && !spec.dowAny) ? (spec.dom.has(t.getDate()) || spec.dow.has(t.getDay())) : (spec.dom.has(t.getDate()) && spec.dow.has(t.getDay()));
    if (!dayOk) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
    if (!spec.hour.has(t.getHours())) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
    if (!spec.min.has(t.getMinutes())) { t.setMinutes(t.getMinutes() + 1, 0, 0); continue; }
    return t;
  }
  return null;
}
