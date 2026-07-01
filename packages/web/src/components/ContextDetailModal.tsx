import type { CSSProperties } from 'react';
import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { Modal } from './common/Modal';
import { Spinner } from './common/Spinner';
import { CONTEXT_WINDOW, type CompactResult } from './tabs/chat/useStructuredChat';

export interface ContextDetailModalProps {
  contextTokens?: number;
  model?: string;
  compacting: boolean;
  compactResult: CompactResult | null;
  compact: () => void;
  onClose: () => void;
}

const row: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--color-border)', fontSize: 13 };

/** Utility modal for the <ContextIndicator> pill: tokens/window/model detail + a Compact button. */
export function ContextDetailModal({ contextTokens, model, compacting, compactResult, compact, onClose }: ContextDetailModalProps) {
  const pct = Math.min(100, Math.round(((contextTokens ?? 0) / CONTEXT_WINDOW) * 100));
  return (
    <Modal open onClose={onClose} title="Context window">
      <div>
        <div style={row}>
          <span style={{ color: 'var(--color-text-secondary)' }}>Tokens used</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{contextTokens !== undefined ? `${contextTokens.toLocaleString()} tokens` : '—'}</span>
        </div>
        <div style={row}>
          <span style={{ color: 'var(--color-text-secondary)' }}>Context window</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{CONTEXT_WINDOW.toLocaleString()} max</span>
        </div>
        <div style={row}>
          <span style={{ color: 'var(--color-text-secondary)' }}>Fill</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{pct}%</span>
        </div>
        <div style={{ ...row, borderBottom: 'none' }}>
          <span style={{ color: 'var(--color-text-secondary)' }}>Model</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{model ?? '—'}</span>
        </div>
      </div>

      {compactResult && !compacting && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 14, padding: '8px 10px', borderRadius: 8,
            background: compactResult.success ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)' : 'color-mix(in srgb, var(--color-status-red) 12%, transparent)',
            fontSize: 12.5,
          }}
        >
          {compactResult.success ? (
            <CheckCircle size={14} weight="fill" color="var(--color-accent)" />
          ) : (
            <WarningCircle size={14} weight="fill" color="var(--color-status-red)" />
          )}
          <span style={{ color: 'var(--color-text-primary)' }}>
            {compactResult.success ? 'Compaction succeeded.' : `Compaction failed${compactResult.error ? `: ${compactResult.error}` : '.'}`}
          </span>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button onClick={onClose} style={{ height: 32, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', cursor: 'pointer' }}>Close</button>
        <button
          disabled={compacting}
          onClick={compact}
          style={{ height: 32, padding: '0 18px', display: 'flex', alignItems: 'center', gap: 6, background: compacting ? 'var(--color-hover)' : 'var(--color-accent)', border: 'none', borderRadius: 8, color: compacting ? 'var(--color-text-tertiary)' : '#08240F', fontWeight: 600, cursor: compacting ? 'default' : 'pointer' }}
        >
          {compacting && <Spinner size={12} color="var(--color-text-tertiary)" />}
          {compacting ? 'Compacting…' : 'Compact'}
        </button>
      </div>
    </Modal>
  );
}
