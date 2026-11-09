/**
 * `dispatch doctor <thread id>` (engineering program W2-G): the plain-text form of the answer of
 * GET /api/terminals/:id/diagnostics. The daemon decides the explanation (core `status/explain.ts`);
 * this file only prints it.
 */

interface Step { label: string; action: string }
interface EventRow { event_type?: string; observed_at?: string; status?: string | null; disposition?: string }
interface Delivery { direction?: string; peerId?: string | null; peerLabel?: string | null; kind?: string; state?: string; attempts?: number; lastError?: string | null; createdAt?: string | null }
export interface DoctorAnswer {
  events?: EventRow[];
  captureFailure?: { reason?: string; occurrences?: number; observed_at?: string } | null;
  status?: string;
  transport?: string;
  process?: { alive: boolean } | null;
  stall?: { stalledSince: string } | null;
  park?: { state: string; provider: string; kind: string; wakeAt: number } | null;
  pendingQuestion?: { source: string } | null;
  deliveries?: Delivery[];
  explanation?: { headline: string; since: string | null; reasons: string[]; nextSteps: Step[] } | null;
}

/** The events the text form prints. `--json` prints all of them. */
const EVENT_ROWS = 20;

/** "2026-11-09 14:05" (or with seconds) from an ISO string or epoch ms; the input as text when it is no time. */
function utc(value: string | number | null | undefined, seconds = false): string {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, seconds ? 19 : 16)}`;
}

/** Left-aligned columns, two spaces between them and before the row; no spaces at a line end. */
function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length)));
  return [head, ...rows].map((r) => `  ${r.map((cell, c) => (cell ?? '').padEnd(widths[c])).join('  ')}`.trimEnd());
}

/** What the owner runs, or where the owner goes, for a next step. */
function stepHint(action: string, id: string): string {
  const path = `/api/terminals/${encodeURIComponent(id)}`;
  switch (action) {
    case 'reset-status': return `dispatch api POST ${path}/reset-status`;
    case 'restart': return `dispatch api POST ${path}/relaunch`;
    case 'open-usage': return 'in the app, open Settings, then Usage limits';
    default: return '';
  }
}

export function formatDoctor(id: string, a: DoctorAnswer): string {
  const lines: string[] = [`Thread ${id}`];
  const facts: string[] = [];
  if (a.status) facts.push(`Status: ${a.status}`);
  if (a.transport) facts.push(`Transport: ${a.transport === 'structured' ? 'Pretty' : 'CLI'}`);
  if (a.explanation || a.process !== undefined) facts.push(`Process: ${a.process ? (a.process.alive ? 'running' : 'not running') : 'not known'}`);
  if (facts.length) lines.push(facts.join('    '));
  if (a.stall) lines.push(`Stall flag: no output since ${utc(a.stall.stalledSince)} UTC`);
  if (a.park) lines.push(`Usage limit: ${a.park.kind} limit of ${a.park.provider}, ${a.park.state}, next try ${utc(a.park.wakeAt)} UTC`);
  if (a.pendingQuestion) lines.push(`Open question: ${a.pendingQuestion.source === 'saved' ? 'saved across a restart' : 'held by the live process'}`);
  if (a.captureFailure) lines.push(`Capture failure: ${a.captureFailure.reason ?? 'no reason'} (${a.captureFailure.occurrences ?? 1} times, last ${utc(a.captureFailure.observed_at)} UTC)`);
  lines.push('');

  const e = a.explanation;
  if (!e) {
    lines.push('This daemon gave no explanation. Update Dispatch, then restart the daemon.');
  } else {
    lines.push(e.headline);
    if (e.since) lines.push(`Since ${utc(e.since)} UTC`);
    lines.push('', 'Why:', ...e.reasons.map((r) => `  - ${r}`), '');
    const steps = (e.nextSteps ?? []).filter((s) => s.action !== 'none');
    if (steps.length === 0) lines.push('Next steps: none.');
    else {
      const width = Math.max(...steps.map((s) => s.label.length)) + 1;
      lines.push('Next steps:', ...steps.map((s) => `  - ${`${s.label}:`.padEnd(width)}  ${stepHint(s.action, id)}`.trimEnd()));
    }
    lines.push('');
    const deliveries = a.deliveries ?? [];
    if (deliveries.length === 0) lines.push('Deliveries: none.');
    else {
      lines.push('Deliveries (newest first):', ...table(
        ['STATE', 'DIRECTION', 'THREAD', 'KIND', 'TRIES', 'CREATED (UTC)', 'NOTE'],
        // The row reads from this thread: a notice that this thread sent goes "to" the other thread.
        deliveries.map((d) => [d.state ?? '', d.direction === 'from' ? 'to' : 'from',
          d.peerId ? (d.peerLabel ? `${d.peerLabel} (${d.peerId})` : d.peerId) : 'not known',
          d.kind ?? '', String(d.attempts ?? 0), utc(d.createdAt, true), d.lastError ?? '']),
      ));
    }
  }
  lines.push('');

  const events = a.events ?? [];
  if (events.length === 0) lines.push('Last events: none.');
  else {
    lines.push('Last events (newest first):', ...table(
      ['TIME (UTC)', 'EVENT', 'STATUS', 'RESULT'],
      events.slice(0, EVENT_ROWS).map((x) => [utc(x.observed_at, true), x.event_type ?? '', x.status ?? '', x.disposition ?? '']),
    ));
    if (events.length > EVENT_ROWS) lines.push(`  (${events.length - EVENT_ROWS} older events not shown; --json prints all of them)`);
  }
  return lines.join('\n');
}
