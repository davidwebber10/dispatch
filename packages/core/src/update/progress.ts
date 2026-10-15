import fs from 'fs';
import path from 'path';

/**
 * The progress of `dispatch update`, as the updater (packages/cli/src/index.ts,
 * progressWriter) writes it to `<dataDir>/update-status.json` at each step, plus the last
 * lines of its output from update.log. The daemon reads it for GET /api/update/progress.
 * The updater runs detached and restarts this daemon at its last step, so the file is the
 * only record that survives the restart.
 */
export type UpdateStep = 'pull' | 'install' | 'build' | 'tools' | 'restart';
export type UpdateProgressState = 'idle' | 'running' | 'restarting' | 'failed' | 'done';
export interface UpdateProgress {
  state: UpdateProgressState;
  step: UpdateStep | null;
  steps: UpdateStep[];
  skipped: UpdateStep[];
  startedAt: string | null;
  stepStartedAt: string | null;
  error: string | null;
  /** On `done`: the version the restarted daemon runs. */
  version: string | null;
  finishedAt: string | null;
  /** The last lines of this update's output (update.log after its last start marker). */
  log: string[];
}

interface StatusFile {
  v: 1;
  state: 'running' | 'restarting' | 'failed' | 'done';
  pid: number | null;
  startedAt: string;
  step: UpdateStep;
  stepStartedAt: string;
  steps: UpdateStep[];
  skipped: UpdateStep[];
  error: string | null;
  version?: string;
  finishedAt?: string;
}

export const STATUS_FILE = 'update-status.json';
const STEPS: UpdateStep[] = ['pull', 'install', 'build', 'tools', 'restart'];
const LOG_LINES = 40;
const LOG_TAIL_BYTES = 64 * 1024;
const START_MARKER = '[dispatch] Update started';
/** An update the daemon started but whose updater never wrote its pid. */
const NO_UPDATER_MS = 2 * 60_000;

const statusPath = (dataDir: string) => path.join(dataDir, STATUS_FILE);

function readStatus(dataDir: string): StatusFile | null {
  try {
    const s = JSON.parse(fs.readFileSync(statusPath(dataDir), 'utf8')) as StatusFile;
    return s && s.v === 1 && typeof s.state === 'string' ? s : null;
  } catch { return null; }
}

function writeStatus(dataDir: string, s: StatusFile): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = statusPath(dataDir);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(s));
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* progress is best-effort */ }
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

function tailLog(logPath: string): string[] {
  try {
    const size = fs.statSync(logPath).size;
    const fd = fs.openSync(logPath, 'r');
    try {
      const len = Math.min(size, LOG_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let text = buf.toString('utf8');
      const at = text.lastIndexOf(START_MARKER);
      if (at >= 0) text = text.slice(text.indexOf('\n', at) + 1);
      return text.split(/\r?\n/).map((l) => stripAnsi(l).trimEnd()).filter((l) => l.length > 0).slice(-LOG_LINES);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

export function readUpdateProgress(o: { dataDir: string; logPath: string; isAlive?: (pid: number) => boolean; now?: Date }): UpdateProgress {
  const s = readStatus(o.dataDir);
  if (!s) return { state: 'idle', step: null, steps: STEPS, skipped: [], startedAt: null, stepStartedAt: null, error: null, version: null, finishedAt: null, log: [] };
  let state: UpdateProgressState = s.state;
  let error = s.error ?? null;
  if (state === 'running') {
    const alive = o.isAlive ?? pidAlive;
    const now = (o.now ?? new Date()).getTime();
    if (s.pid != null && !alive(s.pid)) { state = 'failed'; error = 'The updater stopped before it finished.'; }
    else if (s.pid == null && now - Date.parse(s.startedAt) > NO_UPDATER_MS) { state = 'failed'; error = 'The updater did not start.'; }
  }
  return {
    state, step: s.step ?? null, steps: s.steps?.length ? s.steps : STEPS, skipped: s.skipped ?? [],
    startedAt: s.startedAt ?? null, stepStartedAt: s.stepStartedAt ?? null, error,
    version: s.version ?? null, finishedAt: s.finishedAt ?? null,
    log: tailLog(o.logPath),
  };
}

/** The daemon accepted an update: show "running" at once, before the updater writes its own status. */
export function markUpdateStarted(dataDir: string, now: Date = new Date()): void {
  const t = now.toISOString();
  writeStatus(dataDir, { v: 1, state: 'running', pid: null, startedAt: t, step: 'pull', stepStartedAt: t, steps: STEPS, skipped: [], error: null });
}

/** The updater exited non-zero or could not start. Keeps a step error the updater already wrote. */
export function markUpdateFailed(dataDir: string, reason: string): void {
  const s = readStatus(dataDir);
  if (!s) return;
  if (s.state === 'failed' && s.error) return;
  writeStatus(dataDir, { ...s, state: 'failed', error: reason });
}

/** At boot: an update that was restarting this daemon is done, on this version. */
export function finishRestartedUpdate(dataDir: string, version: string, now: Date = new Date()): void {
  const s = readStatus(dataDir);
  if (s?.state !== 'restarting') return;
  writeStatus(dataDir, { ...s, state: 'done', version, finishedAt: now.toISOString() });
}
