import { useEffect, useState } from 'react';
import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { Spinner } from './common/Spinner';
import { ContextDetailModal } from './ContextDetailModal';
import { contextWindowFor, type CompactResult } from './tabs/chat/useStructuredChat';

/** How long a compaction's success/failure flash stays visible before the indicator
 *  reverts to its normal percentage display. */
const RESULT_FLASH_MS = 3000;

/** Short human label for a raw model id: "claude-opus-4-6" → "Opus 4.6",
 *  "claude-haiku-4-5-20251001" → "Haiku 4.5" (date segment dropped), "grok-4" → "Grok 4".
 *  Non-numeric tails (e.g. "-latest") are dropped too; an unparseable id shows verbatim. */
export function modelDisplayName(model?: string): string | undefined {
  if (!model) return undefined;
  const parts = model.replace(/^claude-/, '').split('-').filter((p) => !/^\d{8}$/.test(p));
  if (!parts.length || !parts[0]) return model;
  const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const nums = parts.slice(1).filter((p) => /^\d+$/.test(p));
  return nums.length ? `${family} ${nums.join('.')}` : family;
}

export interface ContextIndicatorProps {
  contextTokens?: number;
  compacting: boolean;
  compactResult: CompactResult | null;
  model?: string;
  compact: () => void;
}

/**
 * Small, muted context-window fill indicator (thin progress bar + percentage),
 * tappable to open <ContextDetailModal>. Nothing to show before the thread's first
 * assistant turn (contextTokens undefined), so it renders nothing until then —
 * except a compaction's own compacting/result state, which can still flash.
 */
export function ContextIndicator({ contextTokens, compacting, compactResult, model, compact }: ContextIndicatorProps) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);

  // The RESULT itself lives in the hook (compactResult persists until the next
  // compaction) — this local timer only controls how long the toast-like flash
  // shows here before falling back to the normal percentage display.
  useEffect(() => {
    if (!compactResult) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), RESULT_FLASH_MS);
    return () => clearTimeout(t);
  }, [compactResult]);

  if (contextTokens === undefined && !compacting && !flash) return null;

  const pct = Math.min(100, Math.round(((contextTokens ?? 0) / contextWindowFor(model)) * 100));
  const barColor = pct >= 90 ? 'var(--color-status-red)' : pct >= 75 ? 'var(--color-status-yellow)' : 'var(--color-accent)';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Context window detail"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: 'var(--color-text-tertiary)', font: '400 11px var(--font-mono)' }}
      >
        {compacting ? (
          <>
            <Spinner size={10} />
            <span>Compacting…</span>
          </>
        ) : flash && compactResult ? (
          compactResult.success ? (
            <>
              <CheckCircle size={12} weight="fill" color="var(--color-accent)" />
              <span>Compacted</span>
            </>
          ) : (
            <>
              <WarningCircle size={12} weight="fill" color="var(--color-status-red)" />
              <span>Compact failed</span>
            </>
          )
        ) : (
          <>
            {modelDisplayName(model) && <span>{modelDisplayName(model)} ·</span>}
            <span style={{ width: 28, height: 3, borderRadius: 2, background: 'var(--color-border)', overflow: 'hidden', display: 'inline-block' }}>
              <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: barColor }} />
            </span>
            <span>{pct}% context</span>
          </>
        )}
      </button>
      {open && (
        <ContextDetailModal
          contextTokens={contextTokens}
          model={model}
          compacting={compacting}
          compactResult={compactResult}
          compact={compact}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
