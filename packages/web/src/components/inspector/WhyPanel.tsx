import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowClockwise, ArrowCounterClockwise, ChatCircleDots, CheckCircle, Clock, Gauge, HourglassMedium, Lightning,
  PauseCircle, Queue, WarningCircle,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { ThreadDiagnostics } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { useUI } from '../../stores/ui';

type Explanation = NonNullable<ThreadDiagnostics['explanation']>;
type Step = Explanation['nextSteps'][number];

/** The events the panel lists. The route sends up to 200; `dispatch doctor --json` prints all of them. */
const EVENT_ROWS = 20;

const caption: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', margin: '16px 0 6px' };
const stepButton: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 34, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 13, cursor: 'pointer' };
const iconButton: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: 30, height: 30, padding: 0, background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-secondary)', cursor: 'pointer' };
const th: React.CSSProperties = { textAlign: 'left', fontWeight: 500, color: 'var(--color-text-tertiary)', padding: '4px 8px 4px 0', borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '4px 8px 4px 0', borderBottom: '1px solid var(--color-border)', verticalAlign: 'top', overflowWrap: 'anywhere' };
const alertBox: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', border: '1px solid var(--color-status-red)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', lineHeight: 1.45 };

/** The headline's icon and colour, from the rule that the daemon matched. A rule that is not known gets the neutral one. */
function glyphOf(rule: string): { Glyph: Icon; color: string } {
  if (rule === 'working-stalled') return { Glyph: HourglassMedium, color: 'var(--color-status-amber)' };
  if (rule.endsWith('dead-process') || rule.startsWith('error') || rule === 'capped-limit') return { Glyph: WarningCircle, color: 'var(--color-status-red)' };
  if (rule === 'working-no-open-turn' || rule === 'needs-input-no-question') return { Glyph: WarningCircle, color: 'var(--color-status-amber)' };
  if (rule.startsWith('working')) return { Glyph: Lightning, color: 'var(--color-status-green)' };
  if (rule.startsWith('needs-input')) return { Glyph: ChatCircleDots, color: 'var(--color-status-amber)' };
  if (rule === 'parked-limit') return { Glyph: PauseCircle, color: 'var(--color-status-amber)' };
  if (rule === 'queued') return { Glyph: Queue, color: 'var(--color-text-secondary)' };
  if (rule.startsWith('scheduled') || rule === 'starting') return { Glyph: Clock, color: 'var(--color-text-secondary)' };
  return { Glyph: CheckCircle, color: 'var(--color-text-secondary)' };
}

const STEP_ICON: Record<Step['action'], Icon | null> = { 'reset-status': ArrowCounterClockwise, restart: ArrowClockwise, 'open-usage': Gauge, none: null };
const STATUS_WORDS: Record<string, string> = { queued: 'Queued', starting: 'Starting', working: 'Working', needs_input: 'Needs input', idle: 'Waiting', done: 'Done', error: 'Error', scheduled: 'Scheduled' };
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** A time in the reader's own zone; the input as it is when it is no time. */
function localTime(value: string | null | undefined, withDate: boolean): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return withDate
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--color-text-tertiary)' }}>{label}</span>
      <span style={{ color: 'var(--color-text-primary)' }}>{value}</span>
    </span>
  );
}

/**
 * "Why is this thread in this state?" (engineering program W2-G). The daemon explains the state
 * (GET /api/terminals/:id/diagnostics, core `status/explain.ts`); this panel shows the headline, the
 * reasons, the deliveries and the last lifecycle events, and it runs a next step through a route
 * that exists already (reset status, relaunch) or opens Settings at Usage limits.
 *
 * It only explains. A question of the thread stays in the thread: the panel has no answer control.
 * It reads once when it opens and again after a step or on Refresh; it has no timer.
 */
export function WhyPanel({ terminalId, sessionId, onClose }: { terminalId: string; sessionId?: string; onClose?: () => void }) {
  const [data, setData] = useState<ThreadDiagnostics | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stepError, setStepError] = useState<string | null>(null);
  const [running, setRunning] = useState<Step['action'] | null>(null);
  // An answer for a thread that the panel no longer shows is dropped.
  const shown = useRef(terminalId);
  shown.current = terminalId;

  const load = useCallback(async () => {
    const id = terminalId;
    setLoading(true);
    try {
      const answer = await api.getThreadDiagnostics(id);
      if (shown.current !== id) return;
      setData(answer);
      setLoadError(null);
    } catch (e) {
      if (shown.current !== id) return;
      setLoadError(e instanceof Error ? e.message : 'The request failed');
    } finally {
      if (shown.current === id) setLoading(false);
    }
  }, [terminalId]);

  useEffect(() => { setData(null); setLoadError(null); setStepError(null); void load(); }, [load]);

  async function run(step: Step) {
    setStepError(null);
    if (step.action === 'open-usage') { useUI.getState().requestSettings('usage'); onClose?.(); return; }
    if (step.action === 'none') return;
    setRunning(step.action);
    try {
      if (step.action === 'reset-status') {
        useTabs.getState().clearLoading(terminalId);
        await api.resetTerminalStatus(terminalId);
      } else {
        useTabs.getState().markLoading(terminalId);
        await api.relaunchTerminal(terminalId);
      }
      if (sessionId) void useTabs.getState().loadTabs(sessionId);
      await load();
    } catch (e) {
      if (step.action === 'restart') useTabs.getState().clearLoading(terminalId);
      setStepError(`${step.label} failed: ${e instanceof Error ? e.message : 'the request failed'}`);
    } finally {
      setRunning(null);
    }
  }

  if (!data) {
    return (
      <div style={{ padding: 16, fontSize: 13 }}>
        {loadError ? (
          <div role="alert" style={alertBox}>
            <WarningCircle size={18} aria-hidden style={{ flexShrink: 0, color: 'var(--color-status-red)', marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>Could not read the thread state: {loadError}</div>
              <button type="button" onClick={() => void load()} disabled={loading} style={{ ...stepButton, marginTop: 10 }}>
                <ArrowClockwise size={15} aria-hidden />Try again
              </button>
            </div>
          </div>
        ) : (
          <div role="status" style={{ color: 'var(--color-text-secondary)' }}>Reading the thread state…</div>
        )}
      </div>
    );
  }

  const e = data.explanation ?? null;
  const { Glyph, color } = glyphOf(e?.rule ?? '');
  const steps = (e?.nextSteps ?? []).filter((s) => s.action !== 'none');
  const deliveries = data.deliveries ?? [];
  const events = data.events ?? [];

  return (
    <div style={{ padding: 16, fontSize: 13, lineHeight: 1.45, color: 'var(--color-text-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {e && <Glyph size={22} weight="regular" aria-hidden style={{ flexShrink: 0, color, marginTop: 1 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          {e ? (
            <>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{e.headline}</h3>
              {e.since && <div style={{ marginTop: 2, color: 'var(--color-text-secondary)', fontSize: 12 }}>Since {localTime(e.since, true)}</div>}
            </>
          ) : (
            <div role="alert" style={alertBox}>The daemon gave no explanation. Update Dispatch, then restart the daemon.</div>
          )}
        </div>
        <button type="button" aria-label="Refresh" title="Refresh" onClick={() => void load()} disabled={loading} style={{ ...iconButton, opacity: loading ? 0.5 : 1 }}>
          <ArrowClockwise size={15} aria-hidden />
        </button>
      </div>

      {loadError && <div role="alert" style={{ ...alertBox, marginTop: 12 }}>Could not read the thread state: {loadError}</div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', marginTop: 12, fontSize: 12 }}>
        {data.status && <Fact label="Status" value={STATUS_WORDS[data.status] ?? data.status} />}
        {data.transport && <Fact label="Transport" value={data.transport === 'structured' ? 'Pretty' : 'CLI'} />}
        {data.process !== undefined && <Fact label="Process" value={data.process ? (data.process.alive ? 'Running' : 'Not running') : 'Not known'} />}
      </div>

      {e && e.reasons.length > 0 && (
        <ul aria-label="Reasons" style={{ margin: '12px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {e.reasons.map((r, n) => <li key={n}>{r}</li>)}
        </ul>
      )}

      {steps.length > 0 && (
        <div role="group" aria-label="Next steps" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {steps.map((s) => {
            const StepIcon = STEP_ICON[s.action];
            return (
              <button key={s.action} type="button" onClick={() => void run(s)} disabled={running !== null} style={{ ...stepButton, opacity: running !== null && running !== s.action ? 0.6 : 1 }}>
                {StepIcon && <StepIcon size={15} aria-hidden />}{s.label}
              </button>
            );
          })}
        </div>
      )}
      {stepError && <div role="alert" style={{ ...alertBox, marginTop: 10 }}>{stepError}</div>}

      {data.captureFailure && (
        <div style={{ marginTop: 12, color: 'var(--color-text-secondary)', fontSize: 12 }}>
          Capture failure: {data.captureFailure.reason} ({data.captureFailure.occurrences} times, last {localTime(data.captureFailure.observed_at, true)})
        </div>
      )}

      {deliveries.length > 0 && (
        <>
          <div style={caption}>Deliveries</div>
          <table aria-label="Deliveries" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr><th style={th}>State</th><th style={th}>Thread</th><th style={th}>Kind</th><th style={th}>Tries</th><th style={th}>Note</th></tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td style={{ ...td, whiteSpace: 'nowrap', color: d.state === 'pending' ? 'var(--color-status-amber)' : d.state === 'dropped' ? 'var(--color-status-red)' : 'var(--color-text-secondary)' }}>{capital(d.state)}</td>
                  {/* The daemon's direction is seen from this thread: a notice that this thread sent goes TO the other one. */}
                  <td style={td}>{d.direction === 'from' ? 'To' : 'From'} {d.peerLabel ?? d.peerId ?? 'a thread that is not known'}</td>
                  <td style={td}>{d.kind}</td>
                  <td style={td}>{d.attempts}</td>
                  <td style={{ ...td, color: 'var(--color-text-secondary)' }}>{d.lastError ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div style={caption}>Last events</div>
      {events.length === 0 ? (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>The daemon recorded no lifecycle event for this thread.</div>
      ) : (
        <>
          <table aria-label="Last lifecycle events" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr><th style={th}>Time</th><th style={th}>Event</th><th style={th}>Status</th><th style={th}>Result</th></tr>
            </thead>
            <tbody>
              {events.slice(0, EVENT_ROWS).map((x, n) => (
                <tr key={n}>
                  <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }} title={x.observed_at}>{localTime(x.observed_at, false)}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 11 }}>{x.event_type}</td>
                  <td style={td}>{x.status ?? ''}</td>
                  <td style={{ ...td, paddingRight: 0, color: x.disposition === 'applied' || x.disposition === 'inferred' ? 'var(--color-text-secondary)' : 'var(--color-status-amber)' }}>{x.disposition}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.length > EVENT_ROWS && <div style={{ marginTop: 6, color: 'var(--color-text-tertiary)', fontSize: 11.5 }}>The {EVENT_ROWS} newest of {events.length} events.</div>}
        </>
      )}
    </div>
  );
}
