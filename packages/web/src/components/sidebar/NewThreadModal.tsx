import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DownloadSimple, SignIn, TerminalWindow, WarningCircle } from '@phosphor-icons/react';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Spinner';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { timeAgo } from '../../lib/time';
import { useIsMobile } from '../../hooks/useIsMobile';
import { DEFAULT_AUTO_ARCHIVE_MS, fromDuration, toDuration, type DurationUnit } from '../../lib/autoArchive';
import type { CcRecentSession, CodexRecentSession, HarnessSettingsResponse, ProviderName, ProviderStatus } from '../../api/types';
import { HARNESSES, INSTALL_COMMAND, LOGIN_COMMAND, defaultModeFor, type Harness as Harnesses } from '../../lib/harnesses';

/** The harness (agent/shell) a new thread runs. Maps to the wire `type`. */
type Harness = Harnesses['id'];
/** CLI = raw terminal TUI (PTY). Pretty = the structured (stream-json) chat UI. */
type Mode = 'cli' | 'pretty';

const ACCENT = 'var(--color-accent)';
const GLOW = '0 0 6px 1px rgba(62,207,106,.4)';
/** Hairlines inside the panel: the control border, and the quieter row divider. */
const BORDER = '#2C2C32';
const DIVIDER = '#26262B';
/** The selected tint for a harness or mode tile, plus its inset ring. */
const ON_BG = 'color-mix(in srgb, var(--color-accent) 12%, var(--color-elevated))';
const ON_RING = 'inset 0 0 0 1px rgba(62,207,106,.5)';

const UNITS: { value: DurationUnit; label: string }[] = [
  { value: 'minutes', label: 'min' },
  { value: 'hours', label: 'hrs' },
  { value: 'days', label: 'days' },
];

function ClaudeMark({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 512 512" fill="#D97757" style={{ display: 'block' }}>
      <path d="M100.4 340.5l100.7-56.5 1.7-4.9-1.7-2.7-4.9 0-16.8-1-57.5-1.6-49.9-2.1-48.3-2.6-12.2-2.6-11.4-15 1.2-7.5 10.2-6.9 14.7 1.3c18.9 1.3 45.9 3.1 81 5.6l35.2 2.1 52.2 5.4 8.3 0 1.2-3.4-2.8-2.1-2.2-2.1-50.3-34.1-54.4-36-28.5-20.7-15.4-10.5-7.8-9.8-3.4-21.5 14-15.4 18.8 1.3 4.8 1.3 19 14.7 40.7 31.5 53.1 39.1 7.8 6.5 3.1-2.2 .4-1.6-3.5-5.8-28.9-52.2-30.8-53.1-13.7-22-3.6-13.2c-1.3-5.4-2.2-10-2.2-15.5l15.9-21.6 8.8-2.8 21.2 2.8 8.9 7.8 13.2 30.2 21.4 47.5 33.2 64.6 9.7 19.2 5.2 17.8 1.9 5.4 3.4 0 0-3.1 2.7-36.4 5-44.7 4.9-57.5 1.7-16.2 8-19.4 15.9-10.5 12.4 5.9 10.2 14.7-1.4 9.5-6.1 39.5-11.9 61.9-7.8 41.5 4.5 0 5.2-5.2 21-27.8 35.2-44.1 15.5-17.5 18.1-19.3 11.6-9.2 22 0 16.2 24.1-7.3 24.9-22.7 28.7-18.8 24.4-27 36.3-16.8 29 1.6 2.3 4-.4 60.9-13 32.9-5.9 39.3-6.7 17.8 8.3 1.9 8.4-7 17.2-42 10.4-49.2 9.8-73.3 17.3-.9 .7 1 1.3 33 3.1 14.1 .8 34.6 0 64.4 4.8 16.8 11.1 10.1 13.6-1.7 10.4-25.9 13.2c-15.5-3.7-54.4-12.9-116.6-27.7l-28-7-3.9 0 0 2.3 23.3 22.8 42.7 38.6 53.5 49.8 2.7 12.3-6.9 9.7-7.3-1-47-35.4-18.1-15.9-41.1-34.6-2.7 0 0 3.6 9.5 13.9 50 75.2 2.6 23-3.6 7.5-13 4.5-14.2-2.6-29.3-41.1-30.2-46.3-24.4-41.5-3 1.7-14.4 154.8-6.7 7.9-15.5 5.9-13-9.8-6.9-15.9 6.9-31.5 8.3-41.1 6.7-32.7 6.1-40.6 3.6-13.5-.2-.9-3 .4-30.6 42-46.5 62.9-36.8 39.4-8.8 3.5-15.3-7.9 1.4-14.1 8.5-12.6 50.9-64.8 30.7-40.2 19.8-23.2-.1-3.4-1.2 0-135.3 87.8-24.1 3.1-10.4-9.7 1.3-15.9 4.9-5.2 40.7-28-.1 .1 0 .1z" />
    </svg>
  );
}

function OpenAIMark({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 512 512" fill="#ECECEC" style={{ display: 'block' }}>
      <path d="M196.4 185.8l0-48.6c0-4.1 1.5-7.2 5.1-9.2l97.8-56.3c13.3-7.7 29.2-11.3 45.6-11.3 61.4 0 100.4 47.6 100.4 98.3 0 3.6 0 7.7-.5 11.8L343.3 111.1c-6.1-3.6-12.3-3.6-18.4 0L196.4 185.8zM424.7 375.2l0-116.2c0-7.2-3.1-12.3-9.2-15.9L287 168.4 329 144.3c3.6-2 6.7-2 10.2 0L437 200.7c28.2 16.4 47.1 51.2 47.1 85 0 38.9-23 74.8-59.4 89.6l0 0zM166.2 272.8l-42-24.6c-3.6-2-5.1-5.1-5.1-9.2l0-112.6c0-54.8 42-96.3 98.8-96.3 21.5 0 41.5 7.2 58.4 20L175.4 108.5c-6.1 3.6-9.2 8.7-9.2 15.9l0 148.5 0 0zm90.4 52.2l-60.2-33.8 0-71.7 60.2-33.8 60.2 33.8 0 71.7-60.2 33.8zm38.7 155.7c-21.5 0-41.5-7.2-58.4-20l100.9-58.4c6.1-3.6 9.2-8.7 9.2-15.9l0-148.5 42.5 24.6c3.6 2 5.1 5.1 5.1 9.2l0 112.6c0 54.8-42.5 96.3-99.3 96.3l0 0zM173.8 366.5L76.1 310.2c-28.2-16.4-47.1-51.2-47.1-85 0-39.4 23.6-74.8 59.9-89.6l0 116.7c0 7.2 3.1 12.3 9.2 15.9l128 74.2-42 24.1c-3.6 2-6.7 2-10.2 0zm-5.6 84c-57.9 0-100.4-43.5-100.4-97.3 0-4.1 .5-8.2 1-12.3l100.9 58.4c6.1 3.6 12.3 3.6 18.4 0l128.5-74.2 0 48.6c0 4.1-1.5 7.2-5.1 9.2l-97.8 56.3c-13.3 7.7-29.2 11.3-45.6 11.3l0 0zm127 60.9c62 0 113.7-44 125.4-102.4 57.3-14.9 94.2-68.6 94.2-123.4 0-35.8-15.4-70.7-43-95.7 2.6-10.8 4.1-21.5 4.1-32.3 0-73.2-59.4-128-128-128-13.8 0-27.1 2-40.4 6.7-23-22.5-54.8-36.9-89.6-36.9-62 0-113.7 44-125.4 102.4-57.3 14.8-94.2 68.6-94.2 123.4 0 35.8 15.4 70.7 43 95.7-2.6 10.8-4.1 21.5-4.1 32.3 0 73.2 59.4 128 128 128 13.8 0 27.1-2 40.4-6.7 23 22.5 54.8 36.9 89.6 36.9z" />
    </svg>
  );
}

/** xAI's mark — the angular slash monogram. */
function GrokMark({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="#E9E9EC" style={{ display: 'block' }}>
      <path d="M4.2 19.8L14.6 4.2h3.5L7.7 19.8H4.2zm11.1 0l-3.4-5.1 2-3 5.4 8.1h-4z" />
    </svg>
  );
}

/** OpenCode's mark — the square-bracket code glyph, matching its terminal-brand look. */
function OpenCodeMark({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#E9E9EC" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M8 4H5v16h3" />
      <path d="M16 4h3v16h-3" />
      <path d="M10.5 15l3-6" />
    </svg>
  );
}

/** The plain shell has no brand, so it uses the house icon set like every other glyph. */
function TerminalMark({ size }: { size: number }) {
  return <TerminalWindow size={size} weight="regular" color="var(--color-text-secondary)" style={{ display: 'block' }} />;
}

const HARNESS_MARK: Record<Harness, (p: { size: number }) => JSX.Element> = {
  claude: ClaudeMark,
  codex: OpenAIMark,
  grok: GrokMark,
  opencode: OpenCodeMark,
  terminal: TerminalMark,
};

/** The border-drawn chevron the design uses for the model select and the resume disclosure. */
function Chevron({ size, rotate, style }: { size: number; rotate: string; style?: React.CSSProperties }) {
  return (
    <span aria-hidden="true" style={{
      display: 'block', width: size, height: size, flex: 'none',
      borderRight: '1.5px solid var(--color-text-secondary)', borderBottom: '1.5px solid var(--color-text-secondary)',
      transform: rotate, transition: 'transform .15s', ...style,
    }} />
  );
}

/**
 * One settings row: a label on the left, the control on the right, a hairline below.
 * Desktop rows are tight (10px padding); phone rows are 52px tall so every control
 * clears a finger.
 */
function Row({ mobile, last, children }: { mobile: boolean; last?: boolean; children: ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      ...(mobile ? { minHeight: 52, padding: '6px 0' } : { padding: '10px 2px' }),
      borderBottom: last ? 'none' : `1px solid ${DIVIDER}`,
    }}>
      {children}
    </div>
  );
}

export function NewThreadModal({ sessionId, onClose, onCreated }: {
  sessionId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const isMobile = useIsMobile();
  const [harness, setHarness] = useState<Harness>('claude');
  // The initial harness is claude, so the initial mode is claude's default (pretty —
  // see defaultModeFor); a saved per-harness preference overrides it once settings load.
  const [mode, setMode] = useState<Mode>(defaultModeFor(HARNESSES.find((h) => h.id === 'claude')!));
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoArchive, setAutoArchive] = useState(false);
  const [autoArchiveMs, setAutoArchiveMs] = useState(DEFAULT_AUTO_ARCHIVE_MS);
  const [recent, setRecent] = useState<CcRecentSession[] | CodexRecentSession[] | null>(null);
  // The resume list folds away by default: starting fresh is the common case, and the
  // list is the one thing that could push the panel past a phone screen.
  const [resumeOpen, setResumeOpen] = useState(false);

  // Which agent CLIs are actually on the box. `null` = not asked yet: until the answer
  // arrives every card stays enabled, so a slow probe never makes the modal look broken.
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  // Per-harness defaults + the opencode key status, from the daemon. `null` until loaded;
  // the modal works without it (defaults simply don't apply, the key step stays hidden).
  const [harnessSettings, setHarnessSettings] = useState<HarnessSettingsResponse | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
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
  // which is exactly what a CLI-mode thread is for. OpenCode is exempt: its "sign-in" is
  // an OpenRouter API key resolved from Doppler at spawn (needsKey below), not a login
  // command — its own auth-store state is irrelevant when the daemon injects the key.
  const needsLogin = currentStatus?.installed === true && currentStatus.signedIn === false && harness !== 'opencode';
  // OpenCode's gate: installed, but the configured Doppler secret doesn't resolve. Until
  // settings load, assume the key is fine — a slow probe never blocks the modal.
  const needsKey = harness === 'opencode' && selectedAvailable && harnessSettings !== null && !harnessSettings.opencodeKey.present;
  /** A gate card (install / sign-in / API key) replaces the options, the Start button and the resume list. */
  const gated = !selectedAvailable || needsLogin || needsKey;

  // Resuming an on-disk session only makes sense for the harnesses that take an
  // externalId today: Claude Code and Codex. Grok captures no session id yet, and the
  // plain shell has no sessions.
  const canResume = harness === 'claude' || harness === 'codex';
  const showMode = harness !== 'terminal';
  const models = spec.models;
  const prettyDisabled = !spec.modes.includes('pretty');
  const cliDisabled = !spec.modes.includes('cli');
  // A stale pick from a previously-selected harness must never survive onto one that
  // doesn't offer it (Grok is pretty-only; the shell is cli-only).
  const effectiveMode: Mode = spec.modes.includes(mode) ? mode : spec.modes[0];

  const loadProviders = useCallback(async () => {
    try { setProviders(await api.recheckProviders()); } catch { setProviders(null); }
  }, []);

  useEffect(() => { void loadProviders(); }, [loadProviders]);
  useEffect(() => { api.getHarnessSettings().then(setHarnessSettings).catch(() => {}); }, []);

  /** The settings-configured default model for a harness, when it's still a valid option;
   *  OpenCode falls back to its first curated model (it has no "let the CLI choose"). */
  const defaultModelFor = useCallback((h: Harnesses, hs: HarnessSettingsResponse | null): string | null => {
    const pref = hs?.settings?.[h.type]?.defaultModel;
    if (pref && h.models.some((m) => m.model === pref)) return pref;
    return h.id === 'opencode' ? h.models[0]?.model ?? null : null;
  }, []);

  // Apply the saved defaults to the INITIAL harness once settings arrive. Only while the
  // model is untouched (null === "Default"), so a fast first click is never stomped.
  useEffect(() => {
    if (!harnessSettings || model !== null) return;
    const h = HARNESSES.find((x) => x.id === harness)!;
    const m = defaultModelFor(h, harnessSettings);
    if (m) setModel(m);
    const prefMode = harnessSettings.settings?.[h.type]?.defaultMode;
    if (prefMode && h.modes.includes(prefMode)) setMode(prefMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when settings land
  }, [harnessSettings]);

  function selectHarness(h: Harnesses) {
    // Every card selects, including one whose CLI is missing — selecting it is how you
    // reach its install prompt.
    setHarness(h.id);
    setInstallError(null);
    setKeyError(null);
    setResumeOpen(false);
    // Model lists are harness-specific: reset to the harness's configured default.
    setModel(defaultModelFor(h, harnessSettings));
    const prefMode = harnessSettings?.settings?.[h.type]?.defaultMode;
    if (prefMode && h.modes.includes(prefMode)) setMode(prefMode);
    // Each harness opens on its OWN default, mirroring the model reset above — carrying
    // claude's pretty default onto codex would silently change codex's transport.
    else setMode(defaultModeFor(h));
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

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function saveKey() {
    if (keySaving || !harnessSettings || !keyDraft.trim()) return;
    setKeySaving(true);
    setKeyError(null);
    try {
      // POST /api/secrets also fires the daemon's env refresh, so the very next spawn
      // picks the key up — no restart.
      await api.setSecret({ name: harnessSettings.opencodeKey.secret, value: keyDraft.trim() });
      setKeyDraft('');
      setHarnessSettings(await api.getHarnessSettings());
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Could not save the key. Connect Doppler in Settings → Secrets first.');
    }
    setKeySaving(false);
  }

  async function create(externalId?: string) {
    if (busy) return;
    setBusy(true);
    try {
      const config: Record<string, unknown> = {};
      // Pretty → structured transport. Only for harnesses that support it.
      if (showMode && effectiveMode === 'pretty') config.transport = 'structured';
      if (harness !== 'terminal' && model) config.model = model;
      if (autoArchive) { config.autoArchive = true; config.autoArchiveMs = autoArchiveMs; }

      const t = await api.createTerminal(sessionId, {
        type: spec.type,
        externalId,
        ...(Object.keys(config).length ? { config } : {}),
      });
      await useTabs.getState().loadTabs(sessionId);
      useTabs.getState().markLoading(t.id);
      onCreated(t.id);
      onClose();
    } catch { setBusy(false); }
  }

  // ── Sizing: one set of numbers per breakpoint, so the two layouts share every rule
  //    and differ only in scale. Phone controls are 40px tall (finger-sized); desktop
  //    controls are 30–32px.
  const m = isMobile;
  const rowLabel: React.CSSProperties = { fontSize: m ? 15 : 13, color: 'var(--color-text-secondary)' };
  const rowHint: React.CSSProperties = { fontSize: m ? 12 : 11, color: 'var(--color-text-tertiary)' };
  const control: React.CSSProperties = {
    background: 'var(--color-elevated)', border: `1px solid ${BORDER}`, borderRadius: m ? 9 : 7,
    color: 'var(--color-text-primary)', boxSizing: 'border-box',
  };
  const controlWidth = m ? 180 : 160;
  const duration = toDuration(autoArchiveMs || DEFAULT_AUTO_ARCHIVE_MS);
  const gateCard: React.CSSProperties = { padding: '14px 14px 13px', background: 'var(--color-elevated)', border: `1px solid ${BORDER}`, borderRadius: 10 };
  const gateButton = (disabled: boolean): React.CSSProperties => ({
    marginTop: 12, height: 38, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    background: ACCENT, border: 'none', borderRadius: 10, color: '#08240F', fontWeight: 600, fontSize: 13.5,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.7 : 1, boxShadow: GLOW,
  });
  const gateCommand: React.CSSProperties = { marginTop: 9, font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)', background: 'rgba(0,0,0,.22)', border: `1px solid ${BORDER}`, borderRadius: 7, padding: '7px 9px', overflowX: 'auto', whiteSpace: 'nowrap' };

  /** The duration control: a number + unit pair, shown only while auto-archive is on. */
  const durationControl = (
    <>
      <input type="number" min={1} step={1} inputMode="numeric" aria-label="Duration" value={duration.value}
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) setAutoArchiveMs(fromDuration(n, duration.unit)); }}
        style={{ ...control, height: m ? 40 : 30, width: m ? 64 : 52, padding: '0 8px', font: `500 ${m ? 14 : 12}px var(--font-mono)`, textAlign: 'center' }} />
      <select aria-label="Unit" value={duration.unit}
        onChange={(e) => setAutoArchiveMs(fromDuration(duration.value, e.target.value as DurationUnit))}
        style={{ ...control, height: m ? 40 : 30, padding: m ? '0 12px' : '0 8px', color: 'var(--color-text-secondary)', font: `500 ${m ? 14 : 12}px var(--font-mono)`, cursor: 'pointer' }}>
        {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
      </select>
    </>
  );

  const toggleArchive = () => setAutoArchive((v) => !v);

  // The phone sheet is anchored to the bottom, so any change in its height moves its
  // top edge — and the picker's height changes with every selection (a shell has no
  // mode/model rows, a harness may have no history). The main region therefore only
  // ever GROWS while the sheet is open: its floor is the tallest it has been, and a
  // shorter state leaves its slack between the options and the Start button, so the
  // pills stay put at the top and the button stays under the thumb.
  const mainRef = useRef<HTMLDivElement>(null);
  const [floor, setFloor] = useState(0);
  useEffect(() => {
    const el = mainRef.current;
    if (!isMobile || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setFloor((f) => Math.max(f, el.offsetHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile]);

  return (
    <Modal open onClose={onClose} sheet={isMobile} anchor="top">
      <div style={{ display: 'flex', flexDirection: 'column', gap: m ? 14 : 16 }}>
      <div ref={mainRef} style={{ display: 'flex', flexDirection: 'column', gap: m ? 14 : 16, minHeight: m && floor ? floor : undefined }}>
        {/* HARNESS. Desktop: one segmented strip, every harness a column. Phone: a row of
            pills that scrolls sideways, bleeding to the sheet edge. A harness whose CLI is
            missing is dimmed and tagged "Install", but stays SELECTABLE: picking it swaps
            the options below for an install prompt, so the fix sits exactly where you hit
            the problem. */}
        {m ? (
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', margin: '0 -16px', padding: '0 16px', scrollbarWidth: 'none' }}>
            {HARNESSES.map((h) => {
              const on = harness === h.id;
              const available = isAvailable(h);
              const Mark = HARNESS_MARK[h.id];
              return (
                <button key={h.id} type="button" aria-pressed={on}
                  title={available ? undefined : `${h.label} is not installed — select to install it`}
                  onClick={() => selectHarness(h)}
                  style={{
                    flex: 'none', display: 'flex', alignItems: 'center', gap: 7, height: 40, padding: '0 12px 0 10px',
                    borderRadius: 20, cursor: 'pointer', font: '600 12.5px var(--font-sans)',
                    background: on ? ON_BG : 'var(--color-elevated)',
                    border: `1px solid ${on ? 'rgba(62,207,106,.5)' : BORDER}`,
                    color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                    opacity: available || on ? 1 : 0.45,
                    transition: 'background .15s, border-color .15s, opacity .15s',
                  }}>
                  <span style={{ display: 'flex', opacity: on ? 1 : 0.7 }}><Mark size={16} /></span>
                  <div style={{ whiteSpace: 'nowrap' }}>{h.label}</div>
                  {!available && <div style={{ font: '600 9.5px var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase', color: ACCENT }}>Install</div>}
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${HARNESSES.length}, minmax(0, 1fr))`, background: 'var(--color-elevated)', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 3, gap: 3 }}>
            {HARNESSES.map((h) => {
              const on = harness === h.id;
              const available = isAvailable(h);
              const Mark = HARNESS_MARK[h.id];
              return (
                <button key={h.id} type="button" aria-pressed={on}
                  title={available ? undefined : `${h.label} is not installed — select to install it`}
                  onClick={() => selectHarness(h)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 4px 9px',
                    borderRadius: 7, border: 'none', cursor: 'pointer', font: '600 11px var(--font-sans)',
                    background: on ? ON_BG : 'transparent',
                    color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                    boxShadow: on ? ON_RING : 'none',
                    // Dimmed while unavailable, but full strength once selected, so the
                    // selection never looks half-applied.
                    opacity: available || on ? 1 : 0.45,
                    transition: 'background .15s, color .15s, opacity .15s',
                  }}>
                  <span style={{ display: 'flex', opacity: on ? 1 : 0.7 }}><Mark size={18} /></span>
                  <div style={{ whiteSpace: 'nowrap' }}>{h.label}</div>
                  {!available && <div style={{ font: '600 9px var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase', color: ACCENT }}>Install</div>}
                </button>
              );
            })}
          </div>
        )}

        {/* The selected harness has no CLI: everything below the picker is replaced by the
            one action that matters. No point offering a model, a mode, or a Start button for
            something that cannot run. */}
        {selectedAvailable && needsLogin ? (
          <div style={gateCard}>
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
            <div style={gateCommand}>{LOGIN_COMMAND[spec.provider!]}</div>
            <button type="button" disabled={signingIn} onClick={() => void signIn(spec.provider!)} style={gateButton(signingIn)}>
              {signingIn ? (<><Spinner size={13} /> Opening…</>) : (<><SignIn size={15} weight="bold" /> Sign in to {spec.label}</>)}
            </button>
          </div>
        ) : selectedAvailable && needsKey ? (
          <div style={gateCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <SignIn size={16} weight="bold" color="var(--color-status-yellow)" style={{ flex: 'none' }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                OpenCode needs an OpenRouter API key
              </span>
            </div>
            <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
              OpenCode runs open models through OpenRouter. Paste a key from openrouter.ai — it's
              saved to Doppler as <code style={{ font: '400 11px var(--font-mono)' }}>{harnessSettings!.opencodeKey.secret}</code> and
              injected at spawn, never stored in a file. Change the secret later in Settings → Harnesses.
            </div>
            <input
              type="password"
              placeholder="sk-or-v1-…"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              style={{ marginTop: 10, height: 36, width: '100%', padding: '0 12px', background: 'rgba(0,0,0,.22)', border: `1px solid ${BORDER}`, borderRadius: 8, color: 'var(--color-text-primary)', boxSizing: 'border-box', font: '400 12px var(--font-mono)' }}
            />
            {keyError && (
              <div style={{ marginTop: 9, fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-status-red)' }}>{keyError}</div>
            )}
            <button type="button" disabled={keySaving || !keyDraft.trim()} onClick={() => void saveKey()} style={gateButton(keySaving || !keyDraft.trim())}>
              {keySaving ? (<><Spinner size={13} /> Saving…</>) : 'Save key'}
            </button>
          </div>
        ) : !selectedAvailable ? (
          <div style={gateCard}>
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
            <div style={gateCommand}>{INSTALL_COMMAND[spec.provider!]}</div>
            {installError && (
              <div style={{ marginTop: 9, fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-status-red)' }}>{installError}</div>
            )}
            <button type="button" disabled={installing !== null} onClick={() => void install(spec.provider!)} style={gateButton(installing !== null)}>
              {installing === spec.provider
                ? (<><Spinner size={13} /> Installing {spec.label}…</>)
                : (<><DownloadSimple size={15} weight="bold" /> Install {spec.label}</>)}
            </button>
          </div>
        ) : (
        <>
        {/* OPTIONS — a short settings list. Mode and Model only for an agent harness; the
            plain shell says so in their place. Auto-archive is always the last row. */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {showMode && (
            <Row mobile={m}>
              <span style={rowLabel}>Mode</span>
              <div style={{ display: 'flex', background: 'var(--color-elevated)', border: `1px solid ${BORDER}`, borderRadius: m ? 9 : 7, padding: m ? 3 : 2, gap: m ? 3 : 2, width: controlWidth, boxSizing: 'border-box' }}>
                {([['cli', 'CLI'], ['pretty', 'Pretty']] as const).map(([id, title]) => {
                  const disabled = id === 'pretty' ? prettyDisabled : cliDisabled;
                  const on = effectiveMode === id && !disabled;
                  return (
                    <button key={id} type="button" aria-pressed={on} disabled={disabled}
                      aria-label={`${title} mode`}
                      title={disabled ? (id === 'pretty' ? `${spec.label} has no structured transport yet` : `${spec.label} runs structured-only`) : undefined}
                      onClick={() => { if (!disabled) setMode(id); }}
                      style={{
                        flex: 1, font: `600 ${m ? 13 : 12}px var(--font-sans)`, borderRadius: m ? 6 : 5, border: 'none',
                        ...(m ? { height: 34 } : { padding: '5px 4px' }),
                        background: on ? 'color-mix(in srgb, var(--color-accent) 14%, var(--color-elevated))' : 'transparent',
                        boxShadow: on ? 'inset 0 0 0 1px rgba(62,207,106,.55)' : 'none',
                        color: on ? ACCENT : 'var(--color-text-tertiary)',
                        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
                        transition: 'background .15s, color .15s',
                      }}>
                      {title}
                    </button>
                  );
                })}
              </div>
            </Row>
          )}
          {models.length > 0 && (
            <Row mobile={m}>
              <span style={rowLabel}>Model</span>
              {/* A select, not chips: it holds any number of models on one line, and each
                  provider's list grows over time. */}
              <div style={{ position: 'relative', width: controlWidth }}>
                <select aria-label="Model" value={model ?? ''} onChange={(e) => setModel(e.target.value || null)}
                  style={{ ...control, height: m ? 40 : 32, width: '100%', padding: m ? '0 30px 0 12px' : '0 26px 0 10px', fontSize: m ? 14 : 12.5, fontWeight: 500, cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none' }}>
                  {models.map((o) => <option key={o.label} value={o.model ?? ''}>{o.label}</option>)}
                </select>
                <Chevron size={7} rotate="rotate(45deg)" style={{ position: 'absolute', right: m ? 13 : 10, top: m ? 14 : 11, pointerEvents: 'none' }} />
              </div>
            </Row>
          )}
          {harness === 'terminal' && (
            <Row mobile={m}>
              <span style={{ fontSize: m ? 14 : 12.5, color: 'var(--color-text-tertiary)' }}>Plain shell. No mode or model to choose.</span>
            </Row>
          )}
          {/* AUTO-ARCHIVE — the whole row toggles (title or switch). While on, the duration
              sits beside the switch on desktop; on a phone it drops to its own line so the
              inputs stay finger-sized. */}
          <div style={{ display: 'flex', flexDirection: 'column', padding: m ? '6px 0' : 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, ...(m ? { minHeight: 40 } : { padding: '10px 2px' }) }}>
              <span onClick={toggleArchive} style={{ display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer', flex: 1 }}>
                <span style={rowLabel}>Auto-archive when idle</span>
                <span style={rowHint}>{autoArchive ? 'Not while working, queued, or waiting on you' : 'Off'}</span>
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
                {!m && autoArchive && durationControl}
                <button type="button" role="switch" aria-checked={autoArchive} aria-label="Auto-archive when idle" onClick={toggleArchive}
                  style={{ flex: 'none', width: m ? 44 : 34, height: m ? 26 : 20, borderRadius: 13, border: 'none', padding: m ? 3 : 2, cursor: 'pointer', background: autoArchive ? ACCENT : BORDER, transition: 'background .15s', display: 'block' }}>
                  <span style={{ display: 'block', width: m ? 20 : 16, height: m ? 20 : 16, borderRadius: 10, background: 'var(--color-text-primary)', transform: autoArchive ? `translateX(${m ? 18 : 14}px)` : 'translateX(0)', transition: 'transform .15s' }} />
                </button>
              </div>
            </div>
            {m && autoArchive && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)', flex: 1 }}>Archive after</span>
                {durationControl}
              </div>
            )}
          </div>
        </div>

        {/* Takes the grow-only slack on the phone sheet (see `floor`); zero-height otherwise. */}
        <div aria-hidden="true" style={{ flex: 1 }} />

        <button type="button" disabled={busy} onClick={() => void create()}
          style={{ height: m ? 48 : 40, width: '100%', flex: 'none', background: ACCENT, border: 'none', borderRadius: m ? 12 : 10, color: '#08240F', fontWeight: 600, fontSize: m ? 15 : 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1, boxShadow: GLOW }}>
          Start new thread
        </button>

        {/* RESUME — folded behind one line that names the harness and counts what's there.
            Nothing to resume ⇒ nothing shown; still loading ⇒ a quiet one-liner. The header
            lives inside the grow-only region (so a harness with no history does not shrink
            the sheet); the opened list renders below it, outside, so opening it never pads
            the region above. */}
        {canResume && (recent === null ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-text-tertiary)', fontSize: m ? 13 : 12.5, borderTop: `1px solid ${DIVIDER}`, paddingTop: m ? 10 : 12, minHeight: m ? 44 : undefined, boxSizing: 'border-box' }}>
            <Spinner size={12} /> Loading recent sessions…
          </div>
        ) : recent.length > 0 ? (
          <div style={{ borderTop: `1px solid ${DIVIDER}`, paddingTop: m ? 6 : 12 }}>
            <button type="button" onClick={() => setResumeOpen((v) => !v)} aria-expanded={resumeOpen}
              style={{ display: 'flex', alignItems: 'center', gap: m ? 10 : 8, background: 'none', border: 'none', padding: m ? 0 : 2, minHeight: m ? 44 : undefined, cursor: 'pointer', font: `500 ${m ? 14 : 12.5}px var(--font-sans)`, color: 'var(--color-text-secondary)', textAlign: 'left', width: '100%' }}>
              <Chevron size={m ? 7 : 6} rotate={resumeOpen ? 'rotate(45deg)' : 'rotate(-45deg)'} style={{ marginLeft: m ? 3 : 2 }} />
              <span style={{ flex: 1 }}>Or resume a recent {spec.label} session</span>
              <span style={{ font: `500 ${m ? 12 : 11}px var(--font-mono)`, color: 'var(--color-text-tertiary)' }}>{recent.length}</span>
            </button>
          </div>
        ) : null)}
        </>
        )}
      </div>

        {!gated && canResume && recent !== null && recent.length > 0 && resumeOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: m ? 6 : 5, maxHeight: 240, overflowY: 'auto', marginTop: m ? -6 : -8 }}>
            {recent.map((s) => (
              <button key={s.id} type="button" disabled={busy} onClick={() => void create(s.id)}
                style={{ display: 'flex', flexDirection: 'column', gap: m ? 4 : 3, width: '100%', textAlign: 'left', background: 'var(--color-elevated)', border: `1px solid ${BORDER}`, borderRadius: m ? 10 : 8, padding: m ? '11px 12px' : '9px 11px', minHeight: m ? 52 : undefined, cursor: busy ? 'default' : 'pointer', flex: 'none' }}>
                <span style={{ fontSize: m ? 14 : 12.5, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>{s.preview}</span>
                <span style={{ font: `400 ${m ? 11 : 10.5}px var(--font-mono)`, color: 'var(--color-text-tertiary)' }}>
                  {timeAgo(new Date(s.mtime).toISOString())} · {s.messageCount}{s.truncated ? '+' : ''} msg{s.messageCount === 1 ? '' : 's'}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
