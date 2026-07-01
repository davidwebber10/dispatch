// Overseer view — agent-detail header (the WorkerLightbox title block).
//
// The identity + vitals strip at the top of a worker's lightbox: NAME, a one-line
// TASK SUMMARY, and a compact meta row (tokens · time alive · model · ~cost). Every
// field is derived from EXISTING sources — no backend change:
//   • name / time-alive     ← the terminal row (label, createdAt, archivedAt)
//   • tokens / model / cost  ← api.getSessionStats(externalId)  (the agent's ${externalId}.jsonl)
//   • task summary           ← first user turn of api.getConversation(terminalId), else config.mission
//
// Stats poll lightly while the lightbox is open; the seed task is fetched once. We
// re-implement the tiny "time alive" formatter locally rather than importing live.ts's
// private elapsedSince() — it isn't exported, and a local copy also lets us freeze the
// clock at archivedAt for a finished agent (which the start-only helper can't do).

import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../../api/client';
import type { SessionStats } from '../../../api/types';
import { findTerminal, useTabs } from '../../../stores/tabs';

// Light enough to feel live without hammering the disk-reading stats route.
const STATS_POLL_MS = 15_000;

/** "1.2M" / "345k" / "820" — compact cumulative token count. */
function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** Strip the vendor prefix so "claude-opus-4-8" reads as "opus-4-8". */
function fmtModel(m: string): string {
  return m.replace(/^claude-/, '').trim() || m;
}

/**
 * Compact "time alive" from createdAt to endMs. For a finished (archived) agent the
 * caller passes the frozen archivedAt; for a live one endMs is omitted → ticks to now.
 */
function fmtAlive(startIso?: string, endMs?: number): string {
  if (!startIso) return '';
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return '';
  const ms = (endMs ?? Date.now()) - start;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}

/** First non-empty line of the seed task, trimmed to one compact line. */
function firstLine(text: string, max = 140): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function AgentDetailHeader({ terminalId }: { terminalId: string }) {
  const terminal = useTabs((s) => findTerminal(s.byProject, terminalId));
  const externalId = terminal?.externalId ?? null;

  const [stats, setStats] = useState<SessionStats | null>(null);
  const [seed, setSeed] = useState<string | null>(null);
  // Bumped on the poll interval so the live "time alive" clock re-renders each tick.
  const [, setTick] = useState(0);

  // Stats: fetch on open + light poll. Gated on externalId (captured shortly after spawn);
  // the route returns { found:false } for a not-yet-written transcript, so no throw there.
  useEffect(() => {
    if (!externalId) {
      setStats(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const s = await api.getSessionStats(externalId);
        if (!cancelled) setStats(s);
      } catch {
        /* transient network error — keep the last value */
      }
    };
    load();
    const id = window.setInterval(() => {
      setTick((n) => n + 1); // also advances the live clock
      load();
    }, STATS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [externalId]);

  // Seed task: fetched once per terminal. The default conversation window is the TAIL,
  // so we ask for the HEAD ({ before: 200 } → lines [0,200)) to reach the first user turn.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const conv = await api.getConversation(terminalId, { before: 200 });
        const first = conv.items.find((it) => it.kind === 'user' && it.text?.trim());
        if (!cancelled) setSeed(first?.text ? firstLine(first.text) : null);
      } catch {
        if (!cancelled) setSeed(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [terminalId]);

  const agentType = typeof terminal?.config?.agentType === 'string' ? (terminal.config.agentType as string) : '';
  const mission = typeof terminal?.config?.mission === 'string' ? (terminal.config.mission as string) : '';
  const name = terminal?.label || (agentType ? `${agentType} thread` : 'Worker thread');
  const summary = seed || mission;

  // Freeze the clock once the agent is finished (complete_agent → archivedAt); otherwise
  // it ticks to now. archivedAt is the concrete completion marker for a worker terminal;
  // lastActivityAt is the fallback when archivedAt is missing/unparseable.
  let endMs: number | undefined;
  if (terminal?.archivedAt) {
    const a = Date.parse(terminal.archivedAt);
    endMs = Number.isFinite(a)
      ? a
      : terminal.lastActivityAt
        ? Date.parse(terminal.lastActivityAt)
        : undefined;
  }
  const alive = fmtAlive(terminal?.createdAt, endMs);

  const cost = stats?.found && typeof stats.estimatedCostUSD === 'number' ? stats.estimatedCostUSD : 0;

  // Build the meta strip as nodes so the (secondary/approximate) cost can be dimmed.
  const meta: ReactNode[] = [];
  if (stats?.found && typeof stats.totalTokens === 'number' && stats.totalTokens > 0) {
    meta.push(<span key="tok">{fmtTokens(stats.totalTokens)} tokens</span>);
  }
  if (alive) meta.push(<span key="age">{alive}</span>);
  if (stats?.found && stats.model) meta.push(<span key="mod">{fmtModel(stats.model)}</span>);
  if (cost > 0) {
    meta.push(
      <span key="cost" title="Approximate — the server's pricing table may be stale for this model" style={{ opacity: 0.6 }}>
        ~${cost.toFixed(2)}
      </span>,
    );
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.2 }}>
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--tp)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {name}
      </span>
      {summary && (
        <span
          title={summary}
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--tt)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {summary}
        </span>
      )}
      {meta.length > 0 && (
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--ts)',
            display: 'flex',
            alignItems: 'center',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          {meta.map((node, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
              {i > 0 && <span style={{ margin: '0 6px', opacity: 0.45 }}>·</span>}
              {node}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
