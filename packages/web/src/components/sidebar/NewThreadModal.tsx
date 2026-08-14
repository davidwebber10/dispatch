import { useCallback, useEffect, useState } from 'react';
import { CaretRight, CheckCircle, DownloadSimple, SignIn, TerminalWindow, WarningCircle } from '@phosphor-icons/react';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Spinner';
import { AutoArchiveField } from './AutoArchiveField';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { timeAgo } from '../../lib/time';
import { useIsMobile } from '../../hooks/useIsMobile';
import { DEFAULT_AUTO_ARCHIVE_MS } from '../../lib/autoArchive';
import type { CcRecentSession, CodexRecentSession, ProviderName, ProviderStatus } from '../../api/types';
import { HARNESSES, INSTALL_COMMAND, LOGIN_COMMAND, type Harness as Harnesses } from '../../lib/harnesses';

/** The harness (agent/shell) a new thread runs. Maps to the wire `type`. */
type Harness = Harnesses['id'];
/** CLI = raw terminal TUI (PTY). Pretty = the structured (stream-json) chat UI. */
type Mode = 'cli' | 'pretty';

const ACCENT = 'var(--color-accent)';
const GLOW = '0 0 6px 1px rgba(62,207,106,.55)';

function ClaudeMark() {
  return (
    <svg aria-hidden="true" width={20} height={20} viewBox="0 0 512 512" fill="#D97757" style={{ display: 'block' }}>
      <path d="M100.4 340.5l100.7-56.5 1.7-4.9-1.7-2.7-4.9 0-16.8-1-57.5-1.6-49.9-2.1-48.3-2.6-12.2-2.6-11.4-15 1.2-7.5 10.2-6.9 14.7 1.3c18.9 1.3 45.9 3.1 81 5.6l35.2 2.1 52.2 5.4 8.3 0 1.2-3.4-2.8-2.1-2.2-2.1-50.3-34.1-54.4-36-28.5-20.7-15.4-10.5-7.8-9.8-3.4-21.5 14-15.4 18.8 1.3 4.8 1.3 19 14.7 40.7 31.5 53.1 39.1 7.8 6.5 3.1-2.2 .4-1.6-3.5-5.8-28.9-52.2-30.8-53.1-13.7-22-3.6-13.2c-1.3-5.4-2.2-10-2.2-15.5l15.9-21.6 8.8-2.8 21.2 2.8 8.9 7.8 13.2 30.2 21.4 47.5 33.2 64.6 9.7 19.2 5.2 17.8 1.9 5.4 3.4 0 0-3.1 2.7-36.4 5-44.7 4.9-57.5 1.7-16.2 8-19.4 15.9-10.5 12.4 5.9 10.2 14.7-1.4 9.5-6.1 39.5-11.9 61.9-7.8 41.5 4.5 0 5.2-5.2 21-27.8 35.2-44.1 15.5-17.5 18.1-19.3 11.6-9.2 22 0 16.2 24.1-7.3 24.9-22.7 28.7-18.8 24.4-27 36.3-16.8 29 1.6 2.3 4-.4 60.9-13 32.9-5.9 39.3-6.7 17.8 8.3 1.9 8.4-7 17.2-42 10.4-49.2 9.8-73.3 17.3-.9 .7 1 1.3 33 3.1 14.1 .8 34.6 0 64.4 4.8 16.8 11.1 10.1 13.6-1.7 10.4-25.9 13.2c-15.5-3.7-54.4-12.9-116.6-27.7l-28-7-3.9 0 0 2.3 23.3 22.8 42.7 38.6 53.5 49.8 2.7 12.3-6.9 9.7-7.3-1-47-35.4-18.1-15.9-41.1-34.6-2.7 0 0 3.6 9.5 13.9 50 75.2 2.6 23-3.6 7.5-13 4.5-14.2-2.6-29.3-41.1-30.2-46.3-24.4-41.5-3 1.7-14.4 154.8-6.7 7.9-15.5 5.9-13-9.8-6.9-15.9 6.9-31.5 8.3-41.1 6.7-32.7 6.1-40.6 3.6-13.5-.2-.9-3 .4-30.6 42-46.5 62.9-36.8 39.4-8.8 3.5-15.3-7.9 1.4-14.1 8.5-12.6 50.9-64.8 30.7-40.2 19.8-23.2-.1-3.4-1.2 0-135.3 87.8-24.1 3.1-10.4-9.7 1.3-15.9 4.9-5.2 40.7-28-.1 .1 0 .1z" />
    </svg>
  );
}

function OpenAIMark() {
  return (
    <svg aria-hidden="true" width={20} height={20} viewBox="0 0 512 512" fill="#ECECEC" style={{ display: 'block' }}>
      <path d="M196.4 185.8l0-48.6c0-4.1 1.5-7.2 5.1-9.2l97.8-56.3c13.3-7.7 29.2-11.3 45.6-11.3 61.4 0 100.4 47.6 100.4 98.3 0 3.6 0 7.7-.5 11.8L343.3 111.1c-6.1-3.6-12.3-3.6-18.4 0L196.4 185.8zM424.7 375.2l0-116.2c0-7.2-3.1-12.3-9.2-15.9L287 168.4 329 144.3c3.6-2 6.7-2 10.2 0L437 200.7c28.2 16.4 47.1 51.2 47.1 85 0 38.9-23 74.8-59.4 89.6l0 0zM166.2 272.8l-42-24.6c-3.6-2-5.1-5.1-5.1-9.2l0-112.6c0-54.8 42-96.3 98.8-96.3 21.5 0 41.5 7.2 58.4 20L175.4 108.5c-6.1 3.6-9.2 8.7-9.2 15.9l0 148.5 0 0zm90.4 52.2l-60.2-33.8 0-71.7 60.2-33.8 60.2 33.8 0 71.7-60.2 33.8zm38.7 155.7c-21.5 0-41.5-7.2-58.4-20l100.9-58.4c6.1-3.6 9.2-8.7 9.2-15.9l0-148.5 42.5 24.6c3.6 2 5.1 5.1 5.1 9.2l0 112.6c0 54.8-42.5 96.3-99.3 96.3l0 0zM173.8 366.5L76.1 310.2c-28.2-16.4-47.1-51.2-47.1-85 0-39.4 23.6-74.8 59.9-89.6l0 116.7c0 7.2 3.1 12.3 9.2 15.9l128 74.2-42 24.1c-3.6 2-6.7 2-10.2 0zm-5.6 84c-57.9 0-100.4-43.5-100.4-97.3 0-4.1 .5-8.2 1-12.3l100.9 58.4c6.1 3.6 12.3 3.6 18.4 0l128.5-74.2 0 48.6c0 4.1-1.5 7.2-5.1 9.2l-97.8 56.3c-13.3 7.7-29.2 11.3-45.6 11.3l0 0zm127 60.9c62 0 113.7-44 125.4-102.4 57.3-14.9 94.2-68.6 94.2-123.4 0-35.8-15.4-70.7-43-95.7 2.6-10.8 4.1-21.5 4.1-32.3 0-73.2-59.4-128-128-128-13.8 0-27.1 2-40.4 6.7-23-22.5-54.8-36.9-89.6-36.9-62 0-113.7 44-125.4 102.4-57.3 14.8-94.2 68.6-94.2 123.4 0 35.8 15.4 70.7 43 95.7-2.6 10.8-4.1 21.5-4.1 32.3 0 73.2 59.4 128 128 128 13.8 0 27.1-2 40.4-6.7 23 22.5 54.8 36.9 89.6 36.9z" />
    </svg>
  );
}

/** xAI's mark — the angular slash monogram. */
function GrokMark() {
  return (
    <svg aria-hidden="true" width={20} height={20} viewBox="0 0 24 24" fill="#E9E9EC" style={{ display: 'block' }}>
      <path d="M4.2 19.8L14.6 4.2h3.5L7.7 19.8H4.2zm11.1 0l-3.4-5.1 2-3 5.4 8.1h-4z" />
    </svg>
  );
}

/** The plain shell has no brand, so it uses the house icon set like every other glyph. */
function TerminalMark() {
  return <TerminalWindow size={20} weight="regular" color="var(--color-text-secondary)" style={{ display: 'block' }} />;
}

function CheckBadge() {
  return (
    <span aria-hidden="true" style={{ position: 'absolute', top: 5, right: 5, display: 'flex' }}>
      <CheckCircle size={14} weight="fill" color={ACCENT} />
    </span>
  );
}

const HARNESS_MARK: Record<Harness, () => JSX.Element> = {
  claude: ClaudeMark,
  codex: OpenAIMark,
  grok: GrokMark,
  terminal: TerminalMark,
};

export function NewThreadModal({ sessionId, onClose, onCreated }: {
  sessionId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const isMobile = useIsMobile();
  const [harness, setHarness] = useState<Harness>('claude');
  const [mode, setMode] = useState<Mode>('cli');
  const [model, setModel] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [autoArchive, setAutoArchive] = useState(false);
  const [autoArchiveMs, setAutoArchiveMs] = useState(DEFAULT_AUTO_ARCHIVE_MS);
  const [recent, setRecent] = useState<CcRecentSession[] | CodexRecentSession[] | null>(null);

  // Which agent CLIs are actually on the box. `null` = not asked yet: until the answer
  // arrives every card stays enabled, so a slow probe never makes the modal look broken.
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [installing, setInstalling] = useState<ProviderName | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const spec = HARNESSES.find((h) => h.id === harness)!;
  const statusFor = useCallback(
    (p: ProviderName | null) => (p === null ? null : providers?.find((s) => s.name === p) ?? null),
    [providers],
  );
  /** The plain shell always works. An agent harness needs its CLI present. */
  const isAvailable = useCallback(
    (h: Harnesses) => (h.provider === null ? true : statusFor(h.provider)?.installed !== false),
    [statusFor],
  );

  /** Is the harness you have selected actually runnable on this machine? */
  const selectedAvailable = isAvailable(spec);
  const currentStatus = statusFor(spec.provider);
  // Installed but not signed in: still startable. The CLI prompts inside the terminal,
  // which is exactly what a CLI-mode thread is for.
  const needsLogin = currentStatus?.installed === true && currentStatus.signedIn === false;

  // Resuming an on-disk session only makes sense for the harnesses that take an
  // externalId today: Claude Code and Codex. Grok captures no session id yet, and the
  // plain shell has no sessions.
  const canResume = harness === 'claude' || harness === 'codex';
  const showMode = harness !== 'terminal';
  const models = spec.models;
  const prettyDisabled = !spec.pretty;

  const loadProviders = useCallback(async () => {
    try { setProviders(await api.recheckProviders()); } catch { setProviders(null); }
  }, []);

  useEffect(() => { void loadProviders(); }, [loadProviders]);

  function selectHarness(h: Harnesses) {
    // Every card selects, including one whose CLI is missing — selecting it is how you
    // reach its install prompt.
    setHarness(h.id);
    setInstallError(null);
    setModel(null); // model lists are harness-specific — reset to Default
    if (!h.pretty) setMode('cli'); // don't carry a Pretty pick into a harness without it
  }

  /**
   * Open a thread that runs this CLI's login command. The thread is tagged `config.signIn`,
   * which is both what makes the daemon spawn the login command directly (rather than a
   * shell) and the only place Dispatch reads output for a sign-in URL.
   */
  async function signIn(name: ProviderName) {
    if (signingIn) return;
    setSigningIn(true);
    try {
      const t = await api.createTerminal(sessionId, {
        type: 'shell',
        label: `Sign in — ${spec.label}`,
        config: { signIn: name },
      });
      await useTabs.getState().loadTabs(sessionId);
      useTabs.getState().markLoading(t.id);
      onCreated(t.id);
      onClose();
    } catch { setSigningIn(false); }
  }

  async function install(name: ProviderName) {
    if (installing) return;
    setInstalling(name);
    setInstallError(null);
    try {
      const result = await api.installProvider(name);
      setProviders((prev) => (prev ?? []).filter((p) => p.name !== name).concat(result.status));
      if (!result.ok) setInstallError(result.output.trim().split('\n').slice(-2).join(' ') || 'Install failed.');
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Install failed.');
    }
    setInstalling(null);
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
      const config: Record<string, unknown> = {};
      // Pretty → structured transport. Only for harnesses that support it.
      if (showMode && mode === 'pretty' && !prettyDisabled) config.transport = 'structured';
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
      {/* NAME — first, because it's the one field you always fill in and it takes focus. */}
      <div style={sectionStyle}>
        <label style={labelStyle} htmlFor="new-thread-name">Name</label>
        {/* Desktop only: on a phone, autofocus raises the keyboard the instant the
            modal opens, covering the form and fighting the scroll. */}
        <input id="new-thread-name" autoFocus={!isMobile} style={input} placeholder="Optional" aria-label="Thread name" value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
      </div>

      {/* HARNESS — four across. A harness whose CLI is missing is dimmed and labelled
          "Install", but stays SELECTABLE: picking it swaps the options below for an install
          prompt, so the fix sits exactly where you hit the problem. */}
      <div style={sectionStyle}>
        <span style={labelStyle}>Harness</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {HARNESSES.map((h) => {
            const on = harness === h.id;
            const available = isAvailable(h);
            const Mark = HARNESS_MARK[h.id];
            return (
              <button key={h.id} type="button" aria-pressed={on}
                title={available ? undefined : `${h.label} is not installed — select to install it`}
                onClick={() => selectHarness(h)}
                style={{
                  position: 'relative', textAlign: 'center', cursor: 'pointer',
                  background: on ? 'color-mix(in srgb, var(--color-accent) 9%, var(--color-elevated))' : 'var(--color-elevated)',
                  border: `1px solid ${on ? ACCENT : '#2C2C32'}`, borderRadius: 10, padding: '12px 6px 11px',
                  boxShadow: on ? GLOW : 'none',
                  // Dimmed while unavailable, but full strength once selected, so the
                  // selection never looks half-applied.
                  opacity: available || on ? 1 : 0.45,
                  transition: 'border-color .15s ease, background .15s ease, box-shadow .2s ease, opacity .15s ease',
                }}>
                {on && <CheckBadge />}
                <span style={{ display: 'flex', justifyContent: 'center', marginBottom: 7 }}><Mark /></span>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)', lineHeight: 1.2 }}>{h.label}</div>
                {!available && (
                  <div style={{ marginTop: 2, font: '600 9.5px var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase', color: ACCENT }}>Install</div>
                )}
              </button>
            );
          })}
        </div>

      </div>

      {/* The selected harness has no CLI: everything below the picker is replaced by the
          one action that matters. No point offering a model, a mode, or a Start button for
          something that cannot run. */}
      {selectedAvailable && needsLogin ? (
        <div style={{ padding: '14px 14px 13px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SignIn size={16} weight="bold" color="var(--color-status-yellow)" style={{ flex: 'none' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              {spec.label} isn't signed in
            </span>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
            Dispatch can run the sign-in for you and hand you the link. A thread that starts
            without this just stops at a login screen you can't finish from a phone.
          </div>
          <div style={{ marginTop: 9, font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)', background: 'rgba(0,0,0,.22)', border: '1px solid #2C2C32', borderRadius: 7, padding: '7px 9px', overflowX: 'auto', whiteSpace: 'nowrap' }}>
            {LOGIN_COMMAND[spec.provider!]}
          </div>
          <button type="button" disabled={signingIn} onClick={() => void signIn(spec.provider!)}
            style={{ marginTop: 12, height: 38, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: ACCENT, border: 'none', borderRadius: 10, color: '#08240F', fontWeight: 600, fontSize: 13.5, cursor: signingIn ? 'default' : 'pointer', opacity: signingIn ? 0.7 : 1, boxShadow: GLOW }}>
            {signingIn ? (<><Spinner size={13} /> Opening…</>) : (<><SignIn size={15} weight="bold" /> Sign in to {spec.label}</>)}
          </button>
        </div>
      ) : !selectedAvailable ? (
        <div style={{ padding: '14px 14px 13px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <WarningCircle size={16} weight="fill" color="var(--color-status-yellow)" style={{ flex: 'none' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              {spec.label} isn't installed
            </span>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
            Dispatch can install it here, on the machine running the daemon. It takes a few
            minutes, and you can leave this open.
          </div>
          <div style={{ marginTop: 9, font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)', background: 'rgba(0,0,0,.22)', border: '1px solid #2C2C32', borderRadius: 7, padding: '7px 9px', overflowX: 'auto', whiteSpace: 'nowrap' }}>
            {INSTALL_COMMAND[spec.provider!]}
          </div>
          {installError && (
            <div style={{ marginTop: 9, fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-status-red)' }}>{installError}</div>
          )}
          <button type="button" disabled={installing !== null} onClick={() => void install(spec.provider!)}
            style={{ marginTop: 12, height: 38, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: ACCENT, border: 'none', borderRadius: 10, color: '#08240F', fontWeight: 600, fontSize: 13.5, cursor: installing ? 'default' : 'pointer', opacity: installing ? 0.7 : 1, boxShadow: GLOW }}>
            {installing === spec.provider
              ? (<><Spinner size={13} /> Installing {spec.label}…</>)
              : (<><DownloadSimple size={15} weight="bold" /> Install {spec.label}</>)}
          </button>
        </div>
      ) : (
      <>
      {/* MODE + MODEL share one row. Two full-width stacked sections is what made this
          modal long; with a fourth harness it would not fit a phone at all. */}
      {(showMode || models.length > 0) && (
        <div style={{ ...sectionStyle, display: 'grid', gridTemplateColumns: showMode && models.length > 0 ? '1fr 1fr' : '1fr', gap: 10 }}>
          {showMode && (
            <div>
              <span style={labelStyle}>Mode</span>
              <div style={{ display: 'flex', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, padding: 3, gap: 3 }}>
                {([['cli', 'CLI'], ['pretty', 'Pretty']] as const).map(([m, title]) => {
                  const disabled = m === 'pretty' && prettyDisabled;
                  const on = mode === m && !disabled;
                  return (
                    <button key={m} type="button" aria-pressed={on} disabled={disabled}
                      aria-label={`${title} mode`}
                      title={disabled ? `${spec.label} has no structured transport yet` : undefined}
                      onClick={() => { if (!disabled) setMode(m); }}
                      style={{
                        flex: 1, font: '600 12px var(--font-sans)', padding: '6px 4px', borderRadius: 6,
                        background: on ? 'color-mix(in srgb, var(--color-accent) 14%, var(--color-elevated))' : 'transparent',
                        boxShadow: on ? `inset 0 0 0 1px color-mix(in srgb, ${ACCENT} 55%, transparent)` : 'none',
                        border: 'none', color: on ? ACCENT : 'var(--color-text-tertiary)',
                        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
                        transition: 'background .15s, color .15s',
                      }}>
                      {title}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {models.length > 0 && (
            <div>
              <label style={labelStyle} htmlFor="new-thread-model">Model</label>
              {/* A select, not chips: it holds any number of models on one line, and each
                  provider's list grows over time. */}
              <select id="new-thread-model" value={model ?? ''} onChange={(e) => setModel(e.target.value || null)}
                style={{ ...input, height: 34, fontSize: 12.5, fontWeight: 500, cursor: 'pointer', padding: '0 8px' }}>
                {models.map((m) => <option key={m.label} value={m.model ?? ''}>{m.label}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {/* ADVANCED — auto-archive is set once and rarely touched, so it folds away. */}
      <button type="button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}
        style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', padding: '6px 2px', font: '500 12px var(--font-sans)', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
        <CaretRight size={11} weight="bold" style={{ transform: advanced ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
        Advanced
      </button>
      {advanced && (
        <AutoArchiveField
          enabled={autoArchive}
          ms={autoArchiveMs}
          onChange={(enabled, ms) => { setAutoArchive(enabled); setAutoArchiveMs(ms); }}
        />
      )}

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
      </>
      )}
    </Modal>
  );
}
