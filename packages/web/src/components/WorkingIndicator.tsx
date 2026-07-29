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
 * Sibling of WorkingIndicator for a native context COMPACTION (Claude Code's
 * `system/status: compacting`), which occupies the same slot but must NOT read as
 * "answering". Compaction can run for tens of seconds — and a message sent during it
 * just queues — so without a distinct indicator the user thinks the model is replying
 * when it's actually summarizing. A rotating spinner (vs. the Sparkle) and its own
 * label make the two unmistakable.
 */
export function CompactingIndicator() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <div style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 7, background: 'var(--color-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size={13} />
      </div>
      <span className="chat-shimmer" style={{ font: '500 13.5px var(--font-sans)' }}>Compacting context…</span>
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
