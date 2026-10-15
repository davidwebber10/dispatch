import { useEffect, useRef, useState } from 'react';
import { CheckCircle, Circle, MinusCircle, XCircle } from '@phosphor-icons/react';
import { api } from '../../api/client';
import { useUpdate } from '../../stores/update';
import { Spinner } from '../common/Spinner';
import type { UpdateProgress, UpdateStepName } from '../../api/types';

export const STEP_LABEL: Record<UpdateStepName, string> = {
  pull: 'Downloading',
  install: 'Installing packages',
  build: 'Building',
  tools: 'Updating tools',
  restart: 'Restarting',
};

/**
 * Polls GET /api/update/progress: once on mount (an update another client started shows
 * here too), then every second while an update runs. A failed poll during an update means
 * the daemon is restarting. Mounted once, in UpdateModal.
 */
export function useUpdateProgressPoller(): void {
  const inProgress = useUpdate((s) => s.inProgress);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const p = await api.getUpdateProgress();
        if (!stopped) useUpdate.getState().applyProgress(p);
      } catch {
        if (!stopped && useUpdate.getState().inProgress) useUpdate.setState({ progressUnreachable: true });
      }
    };
    void tick();
    if (!inProgress) return () => { stopped = true; };
    const timer = setInterval(() => void tick(), 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [inProgress]);
}

/** m:ss since `iso`, re-rendered every second. */
function Elapsed({ since }: { since: string | null }) {
  const [, setNow] = useState(0);
  useEffect(() => { const t = setInterval(() => setNow((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  if (!since) return null;
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000));
  return <span style={{ font: '400 12px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>;
}

function StepList({ p, failed }: { p: UpdateProgress; failed: boolean }) {
  const at = p.step ? p.steps.indexOf(p.step) : -1;
  return (
    <ol style={{ listStyle: 'none', margin: '14px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 7, textAlign: 'left' }}>
      {p.steps.map((step, k) => {
        const skipped = p.skipped.includes(step);
        const state = failed && k === at ? 'failed' : k < at || (k === at && p.state === 'done') ? 'done' : k === at ? 'current' : 'pending';
        const color = state === 'failed' ? 'var(--color-status-red)' : state === 'pending' ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)';
        return (
          <li key={step} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color }}>
            <span style={{ width: 16, display: 'flex', justifyContent: 'center' }}>
              {state === 'current' ? <Spinner size={14} /> : state === 'failed' ? <XCircle size={16} weight="fill" />
                : skipped ? <MinusCircle size={16} /> : state === 'done' ? <CheckCircle size={16} weight="fill" color="var(--color-accent)" /> : <Circle size={16} />}
            </span>
            <span>{STEP_LABEL[step]}</span>
            {skipped && <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>· skipped, no changes</span>}
          </li>
        );
      })}
    </ol>
  );
}

function LogBox({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  return (
    <div ref={ref} style={{ marginTop: 10, maxHeight: 170, overflowY: 'auto', textAlign: 'left', font: '400 11px/1.5 var(--font-mono)', color: 'var(--color-text-secondary)', background: 'rgba(0,0,0,.35)', border: '1px solid #2C2C32', borderRadius: 8, padding: '7px 9px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {lines.length ? lines.map((l, k) => <div key={k}>{l}</div>) : <div>No output yet.</div>}
    </div>
  );
}

const ghost: React.CSSProperties = { height: 34, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 9, color: 'var(--color-text-secondary)', fontSize: 13, cursor: 'pointer' };
const primary: React.CSSProperties = { ...ghost, background: 'var(--color-accent)', border: 'none', color: '#08240F', fontWeight: 600 };

/** The card body while an update runs: steps, time, output on request, Hide. */
export function UpdateRunning() {
  const p = useUpdate((s) => s.progress);
  const unreachable = useUpdate((s) => s.progressUnreachable);
  const [details, setDetails] = useState(false);
  const restarting = unreachable || p?.state === 'restarting';
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-text-primary)' }}>{restarting ? 'Restarting Dispatch…' : 'Updating Dispatch…'}</span>
        <Elapsed since={p?.startedAt ?? null} />
      </div>
      <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
        {restarting ? 'The server is restarting. ' : ''}The page reloads by itself when the update is done.
      </div>
      {p && p.state !== 'idle' && <StepList p={p} failed={false} />}
      {details && <LogBox lines={p?.log ?? []} />}
      <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button type="button" onClick={() => setDetails((d) => !d)} style={ghost}>{details ? 'Hide details' : 'Show details'}</button>
        <button type="button" onClick={() => useUpdate.setState({ progressHidden: true })} style={ghost}>Hide</button>
      </div>
    </>
  );
}

/** The card body after an update this client watched failed: the step, the error, the output, Retry and Close. */
export function UpdateFailed({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const p = useUpdate((s) => s.progress);
  const failure = useUpdate((s) => s.failure);
  const restartStep = p?.step === 'restart';
  return (
    <>
      <XCircle size={30} weight="fill" color="var(--color-status-red)" />
      <div style={{ marginTop: 6, fontWeight: 600, fontSize: 15, color: 'var(--color-text-primary)' }}>Update failed</div>
      {p && <StepList p={p} failed />}
      <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.5, color: 'var(--color-status-red)', textAlign: 'left', wordBreak: 'break-word' }}>{p?.error ?? failure}</div>
      {!restartStep && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'left' }}>Dispatch still runs the old version, so nothing is broken.</div>}
      <LogBox lines={p?.log ?? []} />
      <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button type="button" onClick={() => useUpdate.setState({ runFailed: false, failure: null, progress: null })} style={ghost}>Close</button>
        <button type="button" onClick={onRetry} disabled={retrying} style={{ ...primary, opacity: retrying ? 0.7 : 1 }}>{retrying ? 'Starting…' : 'Retry'}</button>
      </div>
    </>
  );
}

/** While the window is hidden: a small pill that shows the step and opens the window again. */
export function UpdateBadge() {
  const p = useUpdate((s) => s.progress);
  const unreachable = useUpdate((s) => s.progressUnreachable);
  const label = unreachable || p?.state === 'restarting' ? STEP_LABEL.restart : p?.step ? STEP_LABEL[p.step] : 'Starting';
  return (
    <button type="button" aria-label={`Updating · ${label}`} onClick={() => useUpdate.setState({ progressHidden: false })}
      style={{ position: 'fixed', right: 16, bottom: 'max(16px, env(safe-area-inset-bottom))', zIndex: 280, display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 14px', borderRadius: 999, border: '1px solid #2C3A4A', background: '#1B1B1E', color: 'var(--color-text-primary)', fontSize: 12.5, cursor: 'pointer', boxShadow: '0 10px 30px -10px rgba(0,0,0,.8)' }}>
      <Spinner size={13} /> Updating · {label}
    </button>
  );
}
