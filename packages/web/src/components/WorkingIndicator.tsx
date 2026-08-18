import { useEffect, useRef, useState } from 'react';
import { CloudWarning, Sparkle } from '@phosphor-icons/react';
import { Spinner } from './common/Spinner';

/**
 * The single indeterminate "Working…" indicator, shared by the agent chat and the
 * coordinator stream. ONE spinner — deliberately no progress bar, no percentage, and
 * no thinking-vs-typing split. Global `--color-*` and the `dispatch-wiggle` /
 * `chat-shimmer` classes resolve identically under `.overseer-root`, so it drops into
 * both surfaces unchanged.
 */
export function WorkingIndicator() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <div style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: 'var(--color-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Sparkle size={14} weight="fill" color="var(--color-accent)" className="dispatch-wiggle" />
      </div>
      <span className="chat-shimmer" style={{ font: '500 13.5px var(--font-sans)' }}>Working…</span>
    </div>
  );
}

/**
 * Full-width bar for a native context COMPACTION (Claude Code's `system/status:
 * compacting`), which must NOT read as "answering". Compaction can run for minutes,
 * and a message sent during it queues on the CLI's stdin — so this bar is a visual
 * DIVIDER, not a status row: ChatView renders the turns that queued during the
 * compaction BELOW it, and the caption names that contract. Elapsed time (client
 * clock, started at mount) is the only honest progress metric — the CLI emits no
 * percentage, so the sweep underneath is deliberately indeterminate.
 */
export function CompactingBar({ queued }: { queued: number }) {
  const startedAt = useRef(Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((Date.now() - startedAt.current) / 1000));
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs}s`;
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Spinner size={13} />
        <span className="chat-shimmer" style={{ font: '500 13.5px var(--font-sans)' }}>Compacting context…</span>
        <span style={{ marginLeft: 'auto', font: '500 12px var(--font-mono)', color: 'var(--color-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{elapsed}</span>
      </div>
      <div style={{ position: 'relative', height: 3, borderRadius: 2, background: 'var(--color-hover)', overflow: 'hidden' }}>
        <div className="dispatch-compact-sweep" style={{ position: 'absolute', top: 0, bottom: 0, width: '35%', borderRadius: 2, background: 'var(--color-accent)' }} />
      </div>
      {queued > 0 && (
        <div style={{ font: '400 11.5px var(--font-sans)', color: 'var(--color-text-tertiary)' }}>
          {queued === 1 ? 'The message below sends' : 'The messages below send'} when compacting finishes.
        </div>
      )}
    </div>
  );
}

/**
 * Sibling of WorkingIndicator for a MODEL-CALL RETRY in flight (the CLI's
 * `system/api_retry` events — e.g. a 529 "Overloaded" outage). Retries can run for
 * minutes, and behind a bare "Working…" spinner that reads as a dead session — the
 * user prompts, sees nothing, and gives up before the eventual error result lands.
 * Naming the retry (status + attempt count) makes an outage look like an outage.
 */
export function ApiRetryIndicator({ retry }: { retry: { attempt: number; maxRetries: number; errorStatus?: number } }) {
  const what = retry.errorStatus === 529 ? 'API overloaded' : retry.errorStatus ? `API error ${retry.errorStatus}` : 'API error';
  const attempts = retry.maxRetries > 0 ? ` (${retry.attempt}/${retry.maxRetries})` : '';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <div style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: 'var(--color-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <CloudWarning size={14} weight="fill" color="var(--color-warning, #d9a03f)" />
      </div>
      <span className="chat-shimmer" style={{ font: '500 13.5px var(--font-sans)' }}>{what} — retrying{attempts}…</span>
    </div>
  );
}
