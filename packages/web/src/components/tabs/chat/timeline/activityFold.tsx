import { useEffect, useState, type ReactNode } from 'react';
import { CaretRight, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import type { ConvItem } from '../../../../api/types';
import { Spinner } from '../../../common/Spinner';
import { editDiffStat, ToolCall } from '../../ToolCall';
import { useActivityFoldOpen, useToolExpanded, uiKeyOf } from '../../../../hooks/useToolUIState';
import { fontVar } from '../../../../lib/fontSize';
import { askLook } from '../askLook';
import { MachineryBlock, type ToolPair } from './leaves';
import { rowKey } from './stableId';

/**
 * The activity condenser (option A, owner 2026-11-27): a strip of tool calls between two pieces of
 * prose folds under one row. renderTimeline draws every Pretty view, so this one component serves
 * the thread view, the worker lightbox, Chat and the Control Plane, for every provider.
 *
 * - Running: a spinner, the live step in plain words ("Reading leaves.tsx"), the time and the count.
 * - Settled: one quiet line, "12 steps · 4 read · 2 edited", and the edit stat when it is known.
 * - One tap opens today's strip of rows under the fold row; a tap on a row opens its shelf.
 * - Never folded: prose, images, questions, report_status cards and surface cards (they are not
 *   machinery). A failed call stays visible as its own row under the closed fold.
 * - Open state lives under the strip's FIRST item (useActivityFoldOpen), so it survives a remount.
 *   Open, the fold draws the SAME `nodes` a plain strip draws, in the same order and keys, so an open
 *   call keeps its DOM node and scroll while new calls arrive. A call the reader opened keeps the
 *   fold open for good (like ToolGroup's memberOpen).
 */

/**
 * Whether Pretty folds tool strips here. THE switch for the OS look (askLook.tsx says "no collapsed
 * work summaries"): the owner has not decided, so the OS look keeps today's plain strip. To fold
 * there too, set FOLD_IN_OS_LOOK to true and update the note in askLook.tsx.
 */
export const FOLD_IN_OS_LOOK = false;
export function foldsActivity(): boolean {
  return FOLD_IN_OS_LOOK || !askLook();
}

// Tests of other behavior (ToolGroup, pairing, scroll ids) start with every untouched fold open, so
// they see the strip as it was. Tests of the fold itself leave this off.
let openForTest = false;
export function setFoldsOpenForTest(on: boolean): void {
  openForTest = on;
}

// ---- What a call is, in plain words ---------------------------------------------------------

export type StepKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'mcp' | 'other';

/** The kind of a call. Names differ per provider: Claude `Bash`/`Read`/`mcp__s__t`, Codex
 *  `Shell`/`ApplyPatch`/`mcp:s/t`, Grok `run_terminal_command`, OpenCode lowercase ACP titles
 *  (`bash`), Antigravity `run_command`. */
export function stepKind(toolName?: string): StepKind {
  const n = (toolName ?? '').toLowerCase();
  if (n.startsWith('mcp__') || n.startsWith('mcp:')) return 'mcp';
  if (/^(read|read_file|view|view_file|notebookread|readfile)$/.test(n)) return 'read';
  if (/^(edit|write|multiedit|notebookedit|apply_patch|applypatch|patch|str_replace|search_replace|create_file|write_file|edit_file|filechange)$/.test(n)) return 'edit';
  if (/^(bash|exec|exec_command|command|commandexecution|terminal|run|execute|run_command|run_terminal_command)$/.test(n) || n.endsWith('shell')) return 'run';
  if (/^(grep|glob|ls|toolsearch|find|list|list_dir|codebase_search|grep_search|file_search)$/.test(n) || n.includes('search')) return 'search';
  if (/^(webfetch|fetch|web_fetch|browse)$/.test(n)) return 'web';
  if (/^(task|agent)$/.test(n)) return 'agent';
  return 'other';
}

function parse(input?: string): Record<string, unknown> {
  try { const v = JSON.parse(input ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; }
}
const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const clip = (s: string, n = 42) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
function fileOf(tool: ConvItem): string | undefined {
  const p = parse(tool.toolInput);
  return tool.toolFile ?? (typeof p.file_path === 'string' ? p.file_path : typeof p.path === 'string' ? p.path : undefined);
}

/** One call in plain words. `live`: the call still runs ("Reading x"), else done ("Read x"). */
export function stepPhrase(tool: ConvItem, live: boolean): string {
  const k = stepKind(tool.toolName);
  const p = parse(tool.toolInput);
  const file = fileOf(tool);
  const name = tool.toolName ?? 'tool';
  if (k === 'read') return file ? `${live ? 'Reading' : 'Read'} ${base(file)}` : live ? 'Reading a file' : 'Read a file';
  if (k === 'edit') return file ? `${live ? 'Editing' : 'Edited'} ${base(file)}` : live ? 'Editing a file' : 'Edited a file';
  if (k === 'run') {
    if (typeof p.description === 'string' && p.description.trim()) return clip(p.description.trim());
    const cmd = typeof p.command === 'string' ? p.command : Array.isArray(p.command) ? p.command.join(' ') : tool.toolDetail ?? '';
    const head = cmd.replace(/^cd \S+ && /, '').trim().split(/\s+/).slice(0, 3).join(' ');
    return head ? `${live ? 'Running' : 'Ran'} ${clip(head, 30)}` : live ? 'Running a command' : 'Ran a command';
  }
  if (k === 'search') {
    const q = typeof p.pattern === 'string' ? p.pattern : typeof p.query === 'string' ? p.query : '';
    return q ? `${live ? 'Searching' : 'Searched'} for ${clip(q, 28)}` : live ? 'Searching' : 'Searched';
  }
  if (k === 'web') return live ? 'Fetching a page' : 'Fetched a page';
  if (k === 'agent') return live ? 'Running a helper agent' : 'Ran a helper agent';
  if (k === 'mcp') {
    const [server, fn] = name.startsWith('mcp__') ? name.split('__').slice(1) : name.slice(4).split('/');
    return clip(`${server}: ${(fn ?? '').replace(/_/g, ' ')}`.trim());
  }
  return clip(tool.toolTitle ?? name);
}

// ---- Stats over the strip: only what the data holds -------------------------------------------

export interface FoldStats {
  steps: number;
  running: boolean;
  filesRead: number;
  filesEdited: number;
  /** The summed edit stat, only when EVERY edit gives one (a partial sum would misstate the strip). */
  diff: { add: number; del: number } | null;
  errors: ToolPair[];
  /** The newest call that still runs. */
  live?: ToolPair;
}

export function foldStats(pairs: ToolPair[]): FoldStats {
  const read = new Set<string>();
  const edited = new Set<string>();
  let add = 0, del = 0, edits = 0, stated = 0;
  const errors: ToolPair[] = [];
  for (const pr of pairs) {
    const k = stepKind(pr.tool.toolName);
    const f = fileOf(pr.tool);
    if (k === 'read' && f) read.add(f);
    if (k === 'edit') {
      edits++;
      if (f) edited.add(f);
      const s = editDiffStat(pr.tool.toolName, pr.tool.toolInput);
      if (s) { stated++; add += s.add; del += s.del; }
    }
    if (pr.result?.isError) errors.push(pr);
  }
  const pending = pairs.filter((p) => !p.result);
  return {
    steps: pairs.length,
    running: pending.length > 0,
    filesRead: read.size,
    filesEdited: edited.size,
    diff: edits > 0 && stated === edits ? { add, del } : null,
    errors,
    live: pending[pending.length - 1],
  };
}

/** "12 steps · 4 read · 2 edited", with "Worked 1m 04s" first only when the time is known. */
export function settledLine(s: FoldStats, secs?: number): string {
  const parts = [`${s.steps} step${s.steps !== 1 ? 's' : ''}`];
  if (s.filesRead) parts.push(`${s.filesRead} read`);
  if (s.filesEdited) parts.push(`${s.filesEdited} edited`);
  if (secs !== undefined && secs >= 1) parts.unshift(`Worked ${fmtSecs(secs)}`);
  return parts.join(' · ');
}

export function fmtSecs(secs: number): string {
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;
}

// No provider gives a time per call (ConvItems carry no clock on a live call), so a strip's time is
// what this page SAW: it starts only when the page saw the strip's FIRST call start, and it ends at
// the first render that saw the strip settled. A strip seen first in the middle of its work (a page
// opened mid-turn) or from history shows no time at all, never a guess. Module maps, so a remount
// keeps the clock. Exported for tests only.
export const foldClock = { start: new Map<string, number>(), end: new Map<string, number>(), seen: new Set<string>() };
function useSeenClock(key: string, steps: number, running: boolean): number | undefined {
  const [, tick] = useState(0);
  if (!foldClock.seen.has(key)) {
    foldClock.seen.add(key);
    if (running && steps === 1) foldClock.start.set(key, Date.now());
  }
  // Running again after a pause (a new call): the clock goes on. Settled: it stops at the first
  // render that saw it settled.
  if (running) foldClock.end.delete(key);
  else if (foldClock.start.has(key) && !foldClock.end.has(key)) foldClock.end.set(key, Date.now());
  useEffect(() => {
    if (!running || !foldClock.start.has(key)) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running, key]);
  const start = foldClock.start.get(key);
  if (start === undefined) return undefined;
  return Math.max(0, Math.round(((foldClock.end.get(key) ?? Date.now()) - start) / 1000));
}

// ---- The fold --------------------------------------------------------------------------------

const MONO = (px: number) => `400 ${fontVar(px)} var(--font-mono)`;
const SANS = (px: number, w = 400) => `${w} ${fontVar(px)} var(--font-sans)`;
const HAIR = '1px solid color-mix(in srgb, var(--color-hover) 55%, transparent)';

/** `live`: the surface's turn still runs and this strip ends the timeline, so it counts as running
 *  in the pause between two calls (no call open, the model choosing the next step). */
export function ActivityFold({ foldKey, nodes, pairs, onViewFile, forceOpen = false, live: turnLive = false }: { foldKey: string; nodes: ReactNode[]; pairs: ToolPair[]; onViewFile: (p: string) => void; forceOpen?: boolean; live?: boolean }) {
  const stats = foldStats(pairs);
  const s = turnLive && !stats.running ? { ...stats, running: true } : stats;
  const secs = useSeenClock(foldKey, s.steps, s.running);
  const [manual, setManual] = useActivityFoldOpen(`fold:${foldKey}`, undefined);
  // A call the reader opened keeps the strip open for good: its DOM node and scroll stay.
  const memberOpen = manual === undefined && pairs.some((p) => useToolExpanded.peek(uiKeyOf(p.tool)) === true);
  useEffect(() => { if (memberOpen) setManual(true); });
  const open = forceOpen || (manual ?? (memberOpen || openForTest));
  const failed = s.errors.length > 0;
  const last = pairs[pairs.length - 1];
  const live = s.live ? stepPhrase(s.live.tool, true) : last ? stepPhrase(last.tool, false) : '';
  const summary = settledLine(s, secs);
  const meta = [secs !== undefined ? fmtSecs(secs) : '', `${s.steps} step${s.steps !== 1 ? 's' : ''}`].filter(Boolean).join(' · ');
  return (
    <div data-testid="activity-fold" data-open={open || undefined} data-running={s.running || undefined} style={{ display: 'flex', flexDirection: 'column', margin: '0 -20px', borderTop: '1px solid var(--color-hover)', borderBottom: '1px solid var(--color-hover)' }}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={s.running ? `Working: ${live}, ${meta}` : summary}
        onClick={() => setManual(!open)}
        data-testid="activity-fold-row"
        style={{ width: '100%', minHeight: 44, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '0 20px', display: 'flex', gap: 10, alignItems: 'center', color: 'var(--color-text-secondary)' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
      >
        {s.running
          ? <span style={{ width: 16, flexShrink: 0, display: 'flex', justifyContent: 'center' }}><Spinner size={12} /></span>
          : failed
            ? <WarningCircle size={16} weight="fill" color="var(--color-status-red)" style={{ flexShrink: 0 }} />
            : <CheckCircle size={16} weight="fill" color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />}
        {s.running ? (
          <>
            <span className="chat-shimmer" style={{ minWidth: 0, flex: '1 1 auto', font: SANS(13.5, 500), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{live}</span>
            <span style={{ flexShrink: 0, font: MONO(11.5), color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{meta}</span>
          </>
        ) : (
          <>
            <span style={{ minWidth: 0, flex: '1 1 auto', font: SANS(13), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
            {s.diff && <span style={{ flexShrink: 0, font: MONO(11), color: 'color-mix(in srgb, var(--color-status-green) 60%, var(--color-text-primary))' }}>+{s.diff.add} −{s.diff.del}</span>}
          </>
        )}
        <CaretRight size={11} weight="bold" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)', transition: 'transform .12s ease', transform: open ? 'rotate(90deg)' : 'none' }} />
      </button>
      {open ? (
        // Today's strip, as is, under the fold row.
        <div style={{ borderTop: HAIR }}><MachineryBlock nodes={nodes} bare /></div>
      ) : failed && (
        // A failed call stays in sight under the closed fold, as its own real row.
        <div data-testid="activity-fold-errors" style={{ borderTop: HAIR }}>
          {s.errors.map((p) => <ToolCall key={rowKey(p.tool)} tool={p.tool} result={p.result} onViewFile={onViewFile} />)}
        </div>
      )}
    </div>
  );
}
