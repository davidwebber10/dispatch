import { Sparkle } from '@phosphor-icons/react';

/** "3d 4h" / "2h 30m" / "45m" — mirrors the CLI's own age wording in this dialog. */
export function formatAge(minutes: number): string {
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rem = Math.floor(minutes % 60);
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem === 0 ? `${days}d` : `${days}d ${rem}h`;
}

interface Props {
  ageMinutes: number;
  contextTokens: number;
  onSummarize: () => void;
  onFull: () => void;
}

/**
 * The choice Claude Code shows interactively when resuming an old, large session.
 * Pretty threads run with `-p`, which never renders that Ink dialog, so without this
 * the full session resumes silently and eats the user's limits. Deliberately a
 * dismissible card rather than a modal: nothing here needs to block the composer.
 */
export function ResumeAdviceCard({ ageMinutes, contextTokens, onSummarize, onFull }: Props) {
  return (
    <div
      style={{
        maxWidth: 768,
        margin: '0 auto 8px',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        background: 'var(--color-elevated)',
        padding: '11px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Sparkle size={14} weight="fill" color="var(--color-accent)" style={{ flexShrink: 0 }} />
        <span style={{ font: '600 12.5px var(--font-sans)', color: 'var(--color-text-primary)' }}>
          This session is {formatAge(ageMinutes)} old and {contextTokens.toLocaleString()} tokens.
        </span>
      </div>
      <div style={{ font: '400 12.5px var(--font-sans)', lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
        Resuming the full session will consume a substantial portion of your usage limits.
        Summarizing first keeps every later turn lean.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button
          onClick={onSummarize}
          style={{ border: 'none', borderRadius: 7, padding: '6px 13px', cursor: 'pointer', background: 'var(--color-accent)', color: '#06140B', font: '600 12.5px var(--font-sans)' }}
        >
          Resume from summary
        </button>
        <button
          onClick={onFull}
          style={{ border: '1px solid var(--color-border)', borderRadius: 7, padding: '6px 13px', cursor: 'pointer', background: 'transparent', color: 'var(--color-text-secondary)', font: '500 12.5px var(--font-sans)' }}
        >
          Resume full session
        </button>
      </div>
    </div>
  );
}
