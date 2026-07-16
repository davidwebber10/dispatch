import { useEffect, useState } from 'react';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Spinner';
import { AutoArchiveField } from './AutoArchiveField';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { timeAgo } from '../../lib/time';
import { DEFAULT_AUTO_ARCHIVE_MS } from '../../lib/autoArchive';
import type { CcRecentSession, CodexRecentSession } from '../../api/types';

/** The harness (agent/shell) a new thread runs. Maps to the wire `type`. */
type Harness = 'claude' | 'codex' | 'terminal';
/** CLI = raw terminal TUI (PTY). Pretty = the structured (stream-json) chat UI. */
type Mode = 'cli' | 'pretty';

/**
 * Codex "Pretty" (structured transport) is not wired on the backend yet — the
 * daemon's structured session manager speaks Claude Code's stream-json control
 * protocol only (see sessions/service.ts). Until a Codex structured path lands
 * (Phase 2), the Codex Pretty tile renders disabled ("coming soon") so we never
 * spawn a half-working structured Codex thread. Flip to true when it's ready.
 */
const CODEX_PRETTY_ENABLED = false;

const HARNESSES: { id: Harness; label: string; type: string }[] = [
  { id: 'claude', label: 'Claude Code', type: 'claude-code' },
  { id: 'codex', label: 'Codex', type: 'codex' },
  { id: 'terminal', label: 'Terminal', type: 'shell' },
];

/**
 * Harness-aware model lists. "Default" (model:null) omits the flag and lets the
 * CLI pick. Claude values are `--model` aliases; Codex values are the real
 * `--model` slugs (confirmed from `~/.codex/models_cache.json`).
 */
const MODELS: Record<Harness, { label: string; model: string | null }[]> = {
  claude: [
    { label: 'Default', model: null },
    { label: 'Fable', model: 'fable' },
    { label: 'Opus', model: 'opus' },
    { label: 'Sonnet', model: 'sonnet' },
    { label: 'Haiku', model: 'haiku' },
  ],
  codex: [
    { label: 'Default', model: null },
    { label: '5.6 Sol', model: 'gpt-5.6-sol' },
    { label: '5.6 Terra', model: 'gpt-5.6-terra' },
    { label: '5.6 Luna', model: 'gpt-5.6-luna' },
  ],
  terminal: [],
};

const ACCENT = 'var(--color-accent)';
const GLOW = '0 0 6px 1px rgba(62,207,106,.55)';

function ClaudeMark() {
  return (
    <svg aria-hidden="true" width={22} height={22} viewBox="0 0 512 512" fill="#D97757" style={{ display: 'block' }}>
      <path d="M100.4 340.5l100.7-56.5 1.7-4.9-1.7-2.7-4.9 0-16.8-1-57.5-1.6-49.9-2.1-48.3-2.6-12.2-2.6-11.4-15 1.2-7.5 10.2-6.9 14.7 1.3c18.9 1.3 45.9 3.1 81 5.6l35.2 2.1 52.2 5.4 8.3 0 1.2-3.4-2.8-2.1-2.2-2.1-50.3-34.1-54.4-36-28.5-20.7-15.4-10.5-7.8-9.8-3.4-21.5 14-15.4 18.8 1.3 4.8 1.3 19 14.7 40.7 31.5 53.1 39.1 7.8 6.5 3.1-2.2 .4-1.6-3.5-5.8-28.9-52.2-30.8-53.1-13.7-22-3.6-13.2c-1.3-5.4-2.2-10-2.2-15.5l15.9-21.6 8.8-2.8 21.2 2.8 8.9 7.8 13.2 30.2 21.4 47.5 33.2 64.6 9.7 19.2 5.2 17.8 1.9 5.4 3.4 0 0-3.1 2.7-36.4 5-44.7 4.9-57.5 1.7-16.2 8-19.4 15.9-10.5 12.4 5.9 10.2 14.7-1.4 9.5-6.1 39.5-11.9 61.9-7.8 41.5 4.5 0 5.2-5.2 21-27.8 35.2-44.1 15.5-17.5 18.1-19.3 11.6-9.2 22 0 16.2 24.1-7.3 24.9-22.7 28.7-18.8 24.4-27 36.3-16.8 29 1.6 2.3 4-.4 60.9-13 32.9-5.9 39.3-6.7 17.8 8.3 1.9 8.4-7 17.2-42 10.4-49.2 9.8-73.3 17.3-.9 .7 1 1.3 33 3.1 14.1 .8 34.6 0 64.4 4.8 16.8 11.1 10.1 13.6-1.7 10.4-25.9 13.2c-15.5-3.7-54.4-12.9-116.6-27.7l-28-7-3.9 0 0 2.3 23.3 22.8 42.7 38.6 53.5 49.8 2.7 12.3-6.9 9.7-7.3-1-47-35.4-18.1-15.9-41.1-34.6-2.7 0 0 3.6 9.5 13.9 50 75.2 2.6 23-3.6 7.5-13 4.5-14.2-2.6-29.3-41.1-30.2-46.3-24.4-41.5-3 1.7-14.4 154.8-6.7 7.9-15.5 5.9-13-9.8-6.9-15.9 6.9-31.5 8.3-41.1 6.7-32.7 6.1-40.6 3.6-13.5-.2-.9-3 .4-30.6 42-46.5 62.9-36.8 39.4-8.8 3.5-15.3-7.9 1.4-14.1 8.5-12.6 50.9-64.8 30.7-40.2 19.8-23.2-.1-3.4-1.2 0-135.3 87.8-24.1 3.1-10.4-9.7 1.3-15.9 4.9-5.2 40.7-28-.1 .1 0 .1z" />
    </svg>
  );
}

function OpenAIMark() {
  return (
    <svg aria-hidden="true" width={22} height={22} viewBox="0 0 512 512" fill="#ECECEC" style={{ display: 'block' }}>
      <path d="M196.4 185.8l0-48.6c0-4.1 1.5-7.2 5.1-9.2l97.8-56.3c13.3-7.7 29.2-11.3 45.6-11.3 61.4 0 100.4 47.6 100.4 98.3 0 3.6 0 7.7-.5 11.8L343.3 111.1c-6.1-3.6-12.3-3.6-18.4 0L196.4 185.8zM424.7 375.2l0-116.2c0-7.2-3.1-12.3-9.2-15.9L287 168.4 329 144.3c3.6-2 6.7-2 10.2 0L437 200.7c28.2 16.4 47.1 51.2 47.1 85 0 38.9-23 74.8-59.4 89.6l0 0zM166.2 272.8l-42-24.6c-3.6-2-5.1-5.1-5.1-9.2l0-112.6c0-54.8 42-96.3 98.8-96.3 21.5 0 41.5 7.2 58.4 20L175.4 108.5c-6.1 3.6-9.2 8.7-9.2 15.9l0 148.5 0 0zm90.4 52.2l-60.2-33.8 0-71.7 60.2-33.8 60.2 33.8 0 71.7-60.2 33.8zm38.7 155.7c-21.5 0-41.5-7.2-58.4-20l100.9-58.4c6.1-3.6 9.2-8.7 9.2-15.9l0-148.5 42.5 24.6c3.6 2 5.1 5.1 5.1 9.2l0 112.6c0 54.8-42.5 96.3-99.3 96.3l0 0zM173.8 366.5L76.1 310.2c-28.2-16.4-47.1-51.2-47.1-85 0-39.4 23.6-74.8 59.9-89.6l0 116.7c0 7.2 3.1 12.3 9.2 15.9l128 74.2-42 24.1c-3.6 2-6.7 2-10.2 0zm-5.6 84c-57.9 0-100.4-43.5-100.4-97.3 0-4.1 .5-8.2 1-12.3l100.9 58.4c6.1 3.6 12.3 3.6 18.4 0l128.5-74.2 0 48.6c0 4.1-1.5 7.2-5.1 9.2l-97.8 56.3c-13.3 7.7-29.2 11.3-45.6 11.3l0 0zm127 60.9c62 0 113.7-44 125.4-102.4 57.3-14.9 94.2-68.6 94.2-123.4 0-35.8-15.4-70.7-43-95.7 2.6-10.8 4.1-21.5 4.1-32.3 0-73.2-59.4-128-128-128-13.8 0-27.1 2-40.4 6.7-23-22.5-54.8-36.9-89.6-36.9-62 0-113.7 44-125.4 102.4-57.3 14.8-94.2 68.6-94.2 123.4 0 35.8 15.4 70.7 43 95.7-2.6 10.8-4.1 21.5-4.1 32.3 0 73.2 59.4 128 128 128 13.8 0 27.1-2 40.4-6.7 23 22.5 54.8 36.9 89.6 36.9z" />
    </svg>
  );
}

function TerminalMark() {
  return (
    <svg aria-hidden="true" width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ display: 'block', color: 'var(--color-text-secondary)' }}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" strokeWidth="1.5" />
      <path d="M7 9.5l3 2.4-3 2.4M12.5 14.4h4.5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckBadge() {
  return (
    <span aria-hidden="true" style={{ position: 'absolute', top: 8, right: 8, width: 14, height: 14, borderRadius: '50%', border: `1px solid ${ACCENT}`, display: 'grid', placeItems: 'center' }}>
      <svg width={8} height={8} viewBox="0 0 10 10" fill="none" style={{ color: ACCENT }}>
        <path d="M1.5 5.2l2.2 2.3L8.5 2.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

const CliGlyph = () => (
  <svg aria-hidden="true" width={16} height={16} viewBox="0 0 24 24" fill="none"><path d="M4 6l5 4-5 4M12 15h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const PrettyGlyph = () => (
  <svg aria-hidden="true" width={16} height={16} viewBox="0 0 24 24" fill="none"><path d="M12 3l1.9 4.6L18.7 9l-3.4 3.3.8 4.9L12 14.9 7.9 17.2l.8-4.9L5.3 9l4.8-1.4L12 3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
);

const HARNESS_MARK: Record<Harness, () => JSX.Element> = {
  claude: ClaudeMark,
  codex: OpenAIMark,
  terminal: TerminalMark,
};

export function NewThreadModal({ sessionId, onClose, onCreated }: {
  sessionId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [harness, setHarness] = useState<Harness>('claude');
  const [mode, setMode] = useState<Mode>('cli');
  const [model, setModel] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoArchive, setAutoArchive] = useState(false);
  const [autoArchiveMs, setAutoArchiveMs] = useState(DEFAULT_AUTO_ARCHIVE_MS);
  const [recent, setRecent] = useState<CcRecentSession[] | CodexRecentSession[] | null>(null);

  // Resuming an on-disk session only makes sense for the harnesses that take an
  // externalId today: Claude Code and Codex. The plain shell has no sessions.
  const canResume = harness === 'claude' || harness === 'codex';
  const showMode = harness !== 'terminal';
  const models = MODELS[harness];
  // Codex Pretty is gated off until the backend supports it (Phase 2).
  const codexPrettyDisabled = harness === 'codex' && !CODEX_PRETTY_ENABLED;

  function selectHarness(h: Harness) {
    setHarness(h);
    setModel(null); // model lists are harness-specific — reset to Default
    // Codex can't do Pretty yet; snap back to CLI so a stale Pretty pick from
    // Claude doesn't ride along into a Codex thread.
    if (h === 'codex' && !CODEX_PRETTY_ENABLED) setMode('cli');
  }

  useEffect(() => {
    // Clear any stale list from the previously-selected harness right away, so a
    // switch from e.g. codex -> claude never flashes the old entries.
    setRecent(null);
    if (!canResume) return;
    let on = true;
    const fetcher = harness === 'codex' ? api.recentCodexSessions : api.recentCcSessions;
    fetcher(sessionId).then((r) => { if (on) setRecent(r); }).catch(() => { if (on) setRecent([]); });
    return () => { on = false; };
  }, [sessionId, harness, canResume]);

  // Esc closes the modal (Enter-submit lives on the name field so it can't fire
  // while a chip/card has focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function create(externalId?: string) {
    if (busy) return;
    setBusy(true);
    try {
      const spec = HARNESSES.find((h) => h.id === harness)!;
      const config: Record<string, unknown> = {};
      // Pretty → structured transport. Only for harnesses that support it (never
      // the plain shell; never Codex until Phase 2).
      if (showMode && mode === 'pretty' && !codexPrettyDisabled) config.transport = 'structured';
      if (harness !== 'terminal' && model) config.model = model;
      if (autoArchive) { config.autoArchive = true; config.autoArchiveMs = autoArchiveMs; }

      const t = await api.createTerminal(sessionId, {
        type: spec.type,
        label: name.trim() || undefined,
        externalId,
        ...(Object.keys(config).length ? { config } : {}),
      });
      await useTabs.getState().loadTabs(sessionId);
      useTabs.getState().markLoading(t.id);
      onCreated(t.id);
      onClose();
    } catch { setBusy(false); }
  }

  const labelStyle: React.CSSProperties = { display: 'block', font: '600 10px var(--font-mono)', letterSpacing: '1.3px', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', margin: '0 0 8px' };
  const sectionStyle: React.CSSProperties = { marginBottom: 16 };
  const input: React.CSSProperties = { height: 36, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 14, boxSizing: 'border-box' };

  return (
    <Modal open onClose={onClose} title="New Thread">
      {/* HARNESS */}
      <div style={sectionStyle}>
        <span style={labelStyle}>Harness</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {HARNESSES.map((h) => {
            const on = harness === h.id;
            const Mark = HARNESS_MARK[h.id];
            return (
              <button key={h.id} type="button" aria-pressed={on} onClick={() => selectHarness(h.id)}
                style={{
                  position: 'relative', textAlign: 'center', cursor: 'pointer',
                  background: on ? 'color-mix(in srgb, var(--color-accent) 9%, var(--color-elevated))' : 'var(--color-elevated)',
                  border: `1px solid ${on ? ACCENT : '#2C2C32'}`, borderRadius: 10, padding: '15px 10px 13px',
                  boxShadow: on ? GLOW : 'none', transition: 'border-color .15s ease, background .15s ease, box-shadow .2s ease',
                }}>
                {on && <CheckBadge />}
                <span style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}><Mark /></span>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', lineHeight: 1.2 }}>{h.label}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* MODE (Claude + Codex; not the plain shell) */}
      {showMode && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Mode</span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {([['cli', 'CLI', 'Raw terminal'], ['pretty', 'Pretty', 'Rich chat UI']] as const).map(([m, title, sub]) => {
              const on = mode === m;
              const disabled = m === 'pretty' && codexPrettyDisabled;
              return (
                <button key={m} type="button" aria-pressed={on} disabled={disabled}
                  aria-label={`${title} mode`}
                  onClick={() => { if (!disabled) setMode(m); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left',
                    background: on ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-elevated))' : 'var(--color-elevated)',
                    border: `1px solid ${on ? ACCENT : '#2C2C32'}`, borderRadius: 9, padding: '9px 11px',
                    color: on ? ACCENT : 'var(--color-text-tertiary)', boxShadow: on ? GLOW : 'none',
                    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
                    transition: 'border-color .15s ease, background .15s ease, box-shadow .2s ease',
                  }}>
                  <span style={{ flex: 'none', display: 'flex' }}>{m === 'cli' ? <CliGlyph /> : <PrettyGlyph />}</span>
                  <span>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text-primary)', lineHeight: 1.15 }}>{title}</span>
                    <span style={{ display: 'block', fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 1 }}>{disabled ? 'Coming soon' : sub}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* MODEL */}
      {models.length > 0 && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Model</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {models.map((m) => {
              const on = model === m.model;
              return (
                <button key={m.label} type="button" aria-pressed={on} onClick={() => setModel(m.model)}
                  style={{
                    cursor: 'pointer', font: '500 12px var(--font-sans)', padding: '6px 11px', borderRadius: 7,
                    background: on ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)' : 'var(--color-elevated)',
                    border: `1px solid ${on ? ACCENT : '#2C2C32'}`, color: on ? ACCENT : 'var(--color-text-secondary)',
                    transition: 'border-color .15s, background .15s, color .15s',
                  }}>
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* NAME */}
      <div style={sectionStyle}>
        <label style={labelStyle} htmlFor="new-thread-name">Name</label>
        <input id="new-thread-name" autoFocus style={input} placeholder="Optional" aria-label="Thread name" value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
      </div>

      {/* AUTO-ARCHIVE (whole-row toggle; available for every harness) */}
      <AutoArchiveField
        enabled={autoArchive}
        ms={autoArchiveMs}
        onChange={(enabled, ms) => { setAutoArchive(enabled); setAutoArchiveMs(ms); }}
      />

      <button disabled={busy} onClick={() => void create()}
        style={{ marginTop: 18, height: 40, width: '100%', background: ACCENT, border: 'none', borderRadius: 10, color: '#08240F', fontWeight: 600, fontSize: 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1, boxShadow: GLOW }}>
        Start new thread
      </button>

      {canResume && (recent === null ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-text-tertiary)', fontSize: 13, marginTop: 18 }}>
          <Spinner size={13} /> Loading recent sessions…
        </div>
      ) : recent.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <div style={{ font: '600 10px var(--font-mono)', letterSpacing: '1.3px', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', marginBottom: 9 }}>Resume recent</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 240, overflowY: 'auto' }}>
            {recent.map((s) => (
              <button key={s.id} disabled={busy} onClick={() => void create(s.id)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, padding: '9px 11px', cursor: busy ? 'default' : 'pointer' }}>
                <div style={{ fontSize: 12.5, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.preview}</div>
                <div style={{ marginTop: 3, font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                  {timeAgo(new Date(s.mtime).toISOString())} · {s.messageCount}{s.truncated ? '+' : ''} msg{s.messageCount === 1 ? '' : 's'}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null)}
    </Modal>
  );
}
