import { Sparkle } from '@phosphor-icons/react';

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
