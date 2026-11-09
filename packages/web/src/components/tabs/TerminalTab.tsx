import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CaretDoubleDown, CaretUp, CaretDown, CaretLeft, CaretRight, ArrowElbowDownLeft, MagnifyingGlass, Keyboard, X, type Icon } from '@phosphor-icons/react';
import { Spinner } from '../common/Spinner';
import '@xterm/xterm/css/xterm.css';
import { openTerminalSocket, INITIAL_REPLAY_DESKTOP, INITIAL_REPLAY_MOBILE, MAX_REPLAY, nextReplayStep } from '../../api/terminal-socket';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import { TurnFooter } from './TurnFooter';
import { useDraft } from '../../hooks/useDraft';
import { copyText } from '../../lib/clipboard';
import { isMacLike } from '../../lib/hostkeys';
import { useSettings } from '../../stores/settings';
import { useDictation } from '../../hooks/useDictation';
import { inputMenuRow } from '../dictation/InputActionsMenu';
import { PillComposer } from '../composer/PillComposer';
import { Modal } from '../common/Modal';
import { UploadTray, useInboxUploads } from '../composer/UploadTray';
import { createWriteGate, suppressReplayedQueries } from '../../lib/replayQueries';
import { consumePageTicks, shouldPtyScroll } from '../../lib/ptyWheel';
import { findTerminal, useTabs } from '../../stores/tabs';
import { DocViewer } from '../endless/DocViewer';
import { useThreadDocChips } from '../threadDocs';
import { useActiveTheme } from '../../themes/apply';
import { fontVar, fontVarInput } from '../../lib/fontSize';

type SoftKey = { label: string; seq: string; title?: string; Icon?: Icon };
// Slash commands live in a searchable sheet behind the "/" key. Run-commands end
// in \r so they fire on tap; arg-commands leave a trailing space to type into.
type SlashCmd = { cmd: string; seq: string; desc: string };

// A rebuild's new socket can die, stall, or never deliver its replay frame at
// all — on mobile, exactly where sockets drop. 10s is generous: a 4MB replay
// over slow cellular is the case this whole feature exists to accommodate, so
// this must not be tight enough to abort a merely-slow-but-alive rebuild.
const REBUILD_TIMEOUT_MS = 10_000;

// xterm keeps at most `options.scrollback` lines and trims the HEAD to stay under
// it. Once the buffer sits at that ceiling a larger replay adds no visible history
// at all — it still resets the screen, and the anchor delta (newLength - oldLength)
// collapses to ~0, so the viewport is yanked to scrollToLine(0). A rebuild there is
// pure loss, so we refuse it. The fraction leaves a small margin: the last couple of
// percent of the buffer is not worth a full reset either.
const SCROLLBACK_CAP_FRACTION = 0.98;

// Codex's inline TUI (--no-alt-screen) answers every resize by clearing the screen AND the
// scrollback (CSI 3 J) and printing about 1000 lines of history again. In the browser the clear
// shrinks xterm's scroll area; the browser clamps the viewport's scrollTop and fires a scroll
// event that xterm takes for the reader's own scroll, so the view stops following output and the
// reprint leaves it thousands of lines up. A reader at the bottom when the clear arrives stays at
// the bottom until the reprint has been quiet for REPRINT_QUIET_MS; their own wheel, touch or
// pointer input ends that at once.
const SCROLLBACK_CLEAR = '\x1b[3J';
const REPRINT_QUIET_MS = 400;

// Shared look for every key in the row above the mobile composer. `flex: 0 0 auto` is
// the important part: the row scrolls, so a key keeps its natural width instead of
// dividing the row evenly and shrinking below a hittable size as the count grows.
// The explicit padding overrides the UA button padding — without it a fixed-width
// icon button collapses its SVG to a sliver under the global `border-box`.
const SOFT_KEY: CSSProperties = {
  flex: '0 0 auto', minWidth: 46, height: 36, padding: '0 10px',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--color-elevated)', border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-lg)', cursor: 'pointer',
};

const ENTER: SoftKey = { label: 'Enter', seq: '\r', title: 'Enter', Icon: ArrowElbowDownLeft };
const UP_DOWN: SoftKey[] = [
  { label: 'Up', seq: '\x1b[A', title: 'Up', Icon: CaretUp },
  { label: 'Down', seq: '\x1b[B', title: 'Down', Icon: CaretDown },
];

const CLAUDE_ACTIONS: SoftKey[] = [
  { label: 'esc', seq: '\x1b', title: 'Escape' }, ENTER, ...UP_DOWN,
  { label: '⌃O', seq: '\x0f', title: 'Ctrl-O' },
  { label: '⌃E', seq: '\x05', title: 'Ctrl-E' },
];
// Grok's fullscreen TUI owns its own scrollback. Page Up/Down work even while
// the prompt is focused (mouse-wheel does not). The swipe path sends these
// keys; the buttons are the tap fallback.
const GROK_ACTIONS: SoftKey[] = [
  { label: 'esc', seq: '\x1b', title: 'Escape' }, ENTER, ...UP_DOWN,
  { label: 'PgUp', seq: '\x1b[5~', title: 'Page up' },
  { label: 'PgDn', seq: '\x1b[6~', title: 'Page down' },
];
const CODEX_ACTIONS: SoftKey[] = [
  { label: 'esc', seq: '\x1b', title: 'Escape' }, ENTER, ...UP_DOWN,
];
const SHELL_ACTIONS: SoftKey[] = [
  { label: 'esc', seq: '\x1b', title: 'Escape' },
  { label: 'tab', seq: '\t', title: 'Tab' },
  { label: '⌃C', seq: '\x03', title: 'Ctrl-C' }, ENTER, ...UP_DOWN,
  { label: 'Left', seq: '\x1b[D', title: 'Left', Icon: CaretLeft },
  { label: 'Right', seq: '\x1b[C', title: 'Right', Icon: CaretRight },
];

const CLAUDE_SLASH: SlashCmd[] = [
  { cmd: '/resume', seq: '/resume\r', desc: 'Resume a previous conversation' },
  { cmd: '/clear', seq: '/clear\r', desc: 'Clear the conversation' },
  { cmd: '/compact', seq: '/compact\r', desc: 'Summarize & shrink the context' },
  { cmd: '/context', seq: '/context\r', desc: 'Show context-window usage' },
  { cmd: '/cost', seq: '/cost\r', desc: 'Show token cost this session' },
  { cmd: '/model', seq: '/model ', desc: 'Switch the model' },
  { cmd: '/agents', seq: '/agents\r', desc: 'Manage subagents' },
  { cmd: '/mcp', seq: '/mcp\r', desc: 'MCP server status & tools' },
  { cmd: '/memory', seq: '/memory\r', desc: 'Edit CLAUDE.md memory' },
  { cmd: '/init', seq: '/init\r', desc: 'Generate a CLAUDE.md' },
  { cmd: '/review', seq: '/review\r', desc: 'Review a pull request' },
  { cmd: '/config', seq: '/config\r', desc: 'Open settings' },
  { cmd: '/status', seq: '/status\r', desc: 'Account & session status' },
  { cmd: '/export', seq: '/export\r', desc: 'Export the conversation' },
  { cmd: '/vim', seq: '/vim\r', desc: 'Toggle vim editing mode' },
  { cmd: '/effort', seq: '/effort ', desc: 'Set reasoning effort' },
  { cmd: '/btw', seq: '/btw ', desc: 'Slip in a note mid-task' },
  { cmd: '/help', seq: '/help\r', desc: 'List all commands' },
];
// Codex CLI slash commands (developers.openai.com/codex/cli/slash-commands).
const CODEX_SLASH: SlashCmd[] = [
  { cmd: '/model', seq: '/model\r', desc: 'Model & reasoning effort' },
  { cmd: '/approvals', seq: '/approvals\r', desc: 'Approval mode' },
  { cmd: '/review', seq: '/review\r', desc: 'Review your changes' },
  { cmd: '/new', seq: '/new\r', desc: 'Start a new conversation' },
  { cmd: '/init', seq: '/init\r', desc: 'Create an AGENTS.md' },
  { cmd: '/compact', seq: '/compact\r', desc: 'Summarize & shrink the context' },
  { cmd: '/diff', seq: '/diff\r', desc: 'Show the git diff' },
  { cmd: '/mention', seq: '/mention ', desc: 'Mention a file' },
  { cmd: '/status', seq: '/status\r', desc: 'Session status' },
  { cmd: '/mcp', seq: '/mcp\r', desc: 'MCP tools' },
  { cmd: '/resume', seq: '/resume\r', desc: 'Resume a conversation' },
  { cmd: '/quit', seq: '/quit\r', desc: 'Quit Codex' },
];
// Clears what is typed in an agent's prompt (2026-11-05: text sometimes lands in Claude Code's
// box and has to go). Per line: Ctrl+E to its end, Ctrl+U to cut it, Backspace to join the
// line above; repeated so a multi-line prompt empties too. On an empty prompt every key is a
// no-op. Not Ctrl+C or a double Esc: on an empty prompt those exit or open the rewind menu.
const CLEAR_INPUT: SoftKey = { label: 'Clear input', seq: '\x05\x15\x7f'.repeat(30), title: 'Clear the typed input' };
const LEFT_RIGHT: SoftKey[] = [
  { label: 'Left', seq: '\x1b[D', title: 'Left', Icon: CaretLeft },
  { label: 'Right', seq: '\x1b[C', title: 'Right', Icon: CaretRight },
];
const TAB: SoftKey = { label: 'tab', seq: '\t', title: 'Tab' };
/** Two lines of the phone composer's text box (a 42 px first line + one 22 px line): the drag handle's floor. */
const TWO_LINES = 64;

/** The Keys sheet behind the composer's +: the old row's keys, then more per harness. */
function sheetKeysFor(type?: string): { title: string; keys: SoftKey[] }[] {
  const { actions } = keysFor(type);
  const nav = [...actions, ...LEFT_RIGHT.filter((k) => !actions.some((a) => a.label === k.label))];
  if (type === 'shell') {
    return [
      { title: 'Keys', keys: nav },
      { title: 'Control', keys: [
        { label: '⌃D', seq: '\x04', title: 'Ctrl-D (end of input)' },
        { label: '⌃L', seq: '\x0c', title: 'Ctrl-L (clear screen)' },
        { label: '⌃R', seq: '\x12', title: 'Ctrl-R (history search)' },
        { label: '⌃Z', seq: '\x1a', title: 'Ctrl-Z (suspend)' },
        { label: '⌃A', seq: '\x01', title: 'Ctrl-A (line start)' },
        { label: '⌃E', seq: '\x05', title: 'Ctrl-E (line end)' },
        { label: 'Clear line', seq: '\x05\x15', title: 'Clear the typed line' },
      ] },
    ];
  }
  if (type === 'grok') return [{ title: 'Keys', keys: [...nav, TAB, { label: '⌃C', seq: '\x03', title: 'Ctrl-C' }] }];
  if (type === 'codex') {
    return [
      { title: 'Keys', keys: [...nav, TAB] },
      { title: 'Codex', keys: [
        CLEAR_INPUT,
        { label: '⌃T', seq: '\x14', title: 'Ctrl-T (transcript)' },
        { label: '⌃C', seq: '\x03', title: 'Ctrl-C (interrupt; twice quits)' },
      ] },
    ];
  }
  return [
    { title: 'Keys', keys: [...nav, TAB] },
    { title: 'Claude Code', keys: [
      CLEAR_INPUT,
      { label: 'Mode', seq: '\x1b[Z', title: 'Shift-Tab (cycle permission mode)' },
      { label: '⌃R', seq: '\x12', title: 'Ctrl-R (history search)' },
      { label: '⌃B', seq: '\x02', title: 'Ctrl-B (run in background)' },
      { label: '⌃C', seq: '\x03', title: 'Ctrl-C (interrupt; twice quits)' },
    ] },
  ];
}

/** Pages of at most two rows of four (2026-11-07): a group with more keys runs onto a second page. */
function keyPages(groups: { title: string; keys: SoftKey[] }[]): { title: string; keys: SoftKey[] }[] {
  return groups.flatMap((g) => {
    const out: { title: string; keys: SoftKey[] }[] = [];
    for (let i = 0; i < g.keys.length; i += 8) out.push({ title: g.keys.length > 8 ? `${g.title} ${i / 8 + 1}` : g.title, keys: g.keys.slice(i, i + 8) });
    return out;
  });
}

/**
 * The CLI keys (2026-11-07): a short panel that sits on the composer, as wide as the screen, one
 * page per group that slides left and right. It leaves the terminal in view, so arrows through a
 * menu show their effect; it stays open between taps. The keyboard button or Close shuts it.
 */
function KeysPager({ pages, onKey, onClose }: { pages: { title: string; keys: SoftKey[] }[]; onKey: (seq: string) => void; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const pager = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // A tap anywhere else closes it (owner, 2026-11-07). The keyboard button toggles on its own.
  useEffect(() => {
    const onDown = (e: Event) => {
      const t = e.target as Element | null;
      if (!t || box.current?.contains(t) || t.closest?.('[data-keys-toggle]')) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);
  const go = (i: number) => { const el = pager.current; if (el) el.scrollTo?.({ left: i * el.clientWidth, behavior: 'smooth' }); setPage(i); };
  return (
    <div ref={box} role="dialog" aria-label="Keys" data-variant="pager"
      style={{ position: 'absolute', left: 8, right: 8, bottom: '100%', marginBottom: 6, zIndex: 10, background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: '0 -10px 28px -14px var(--color-shadow)', padding: '6px 0 8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px 4px 12px', height: 26 }}>
        <span style={{ font: `600 ${fontVar(10.5)} var(--font-mono)`, letterSpacing: '.08em', color: 'var(--color-text-tertiary)', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pages[page]?.title}</span>
        <span style={{ display: 'flex', gap: 5, marginLeft: 'auto' }}>
          {pages.length > 1 && pages.map((p, i) => (
            <button key={p.title} type="button" aria-label={`Page ${i + 1}: ${p.title}`} aria-current={i === page ? 'true' : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => go(i)}
              style={{ width: 7, height: 7, padding: 0, border: 'none', borderRadius: '50%', cursor: 'pointer', background: i === page ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', opacity: i === page ? 1 : 0.5 }} />
          ))}
        </span>
        <button type="button" aria-label="Close" onMouseDown={(e) => e.preventDefault()} onClick={onClose}
          style={{ width: 26, height: 26, padding: 0, border: 'none', background: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <X size={15} />
        </button>
      </div>
      <div ref={pager} data-testid="keys-pager"
        onScroll={(e) => { const el = e.currentTarget; if (el.clientWidth) setPage(Math.round(el.scrollLeft / el.clientWidth)); }}
        style={{ display: 'flex', overflowX: 'auto', scrollSnapType: 'x mandatory', scrollbarWidth: 'none', overscrollBehaviorX: 'contain' }}>
        {pages.map((p) => (
          <div key={p.title} role="group" aria-label={p.title}
            style={{ flex: '0 0 100%', scrollSnapAlign: 'start', boxSizing: 'border-box', padding: '0 10px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gridAutoRows: 42, gap: 6, alignContent: 'start' }}>
            {p.keys.map((k) => (
              <button key={k.label} type="button" title={k.title} aria-label={k.title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onKey(k.seq)}
                style={{ ...SOFT_KEY, minWidth: 0, height: 42, color: 'var(--color-text-primary)', font: k.label.length > 3 && !k.Icon ? `500 ${fontVar(12.5)} var(--font-sans)` : `500 ${fontVar(15)} var(--font-mono)` }}>
                {k.Icon ? <k.Icon size={19} weight="bold" /> : k.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function keysFor(type?: string): { actions: SoftKey[]; slash: SlashCmd[] } {
  if (type === 'codex') return { actions: CODEX_ACTIONS, slash: CODEX_SLASH };
  if (type === 'grok') return { actions: GROK_ACTIONS, slash: [] };
  if (type === 'shell') return { actions: SHELL_ACTIONS, slash: [] };
  return { actions: CLAUDE_ACTIONS, slash: CLAUDE_SLASH };
}

/** `footer` renders under the terminal, in the turn footer with the ask strip (a CLI AI thread's
 *  outcome card — see TurnFooter). */
export function TerminalTab({ terminalId, socketFactory = openTerminalSocket, footer }: { terminalId: string; socketFactory?: typeof openTerminalSocket; footer?: ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollOverlayRef = useRef<HTMLDivElement>(null);
  const sockRef = useRef<ReturnType<typeof openTerminalSocket> | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const [meta, setMeta] = useState<Terminal | null>(null);
  const cachedType = useTabs((s) => findTerminal(s.byProject, terminalId)?.type);
  const termType = cachedType ?? meta?.type;
  // A link the CLI prints (OSC 8) routes like a link in a message; the handler reads it through a ref.
  const cachedProject = useTabs((s) => findTerminal(s.byProject, terminalId)?.sessionId);
  const docChips = useThreadDocChips(cachedProject ?? meta?.sessionId, terminalId);
  const docChipsRef = useRef(docChips);
  docChipsRef.current = docChips;
  const typeRef = useRef(termType);
  typeRef.current = termType;
  const [drop, setDrop] = useState(false);
  const [note, setNote] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [mobileInput, setMobileInput, clearMobileInput] = useDraft(terminalId);
  // The phone composer's dock (2026-11-07): the empty box's height, measured; the box grows over the terminal.
  const composerOverlayRef = useRef<HTMLDivElement | null>(null);
  const [dockH, setDockH] = useState<number | null>(null);
  const [tall, setTall] = useState(false);
  // The box's height while dragged by its handle (owner, 2026-11-07: drag it up and down, no tap
  // toggle). Null: as tall as the text, up to the composer's own cap.
  const [boxH, setBoxH] = useState<number | null>(null);
  const dragStart = useRef<{ y: number; h: number } | null>(null);
  // Measure the box while it is empty (one line): that height is the dock's. A box with text
  // keeps the last empty height, so the terminal above never moves while you type.
  const emptyInput = !mobileInput;
  useEffect(() => {
    const el = composerOverlayRef.current;
    if (!el || !emptyInput) return;
    const take = () => { const h = el.offsetHeight; if (h > 0) setDockH(h); };
    take();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(take);
    ro.observe(el);
    return () => ro.disconnect();
  }, [emptyInput]);
  // A sent (cleared) box comes back full size next time.
  useEffect(() => { if (emptyInput) setBoxH(null); }, [emptyInput]);
  const termFileInputRef = useRef<HTMLInputElement>(null);
  const sttConfigured = useSettings((s) => !!s.sttProvider && !!s.sttModel && !!s.sttSecretName);
  const dictation = useDictation((text) => {
    setMobileInput((mobileInput ? mobileInput + ' ' : '') + text);
  });
  const [slashOpen, setSlashOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const isMobile = useIsMobile();
  const grokFlush = isMobile && termType === 'grok';
  const termFontSize = useSettings((s) => s.fontSize);
  const termTextScale = useSettings((s) => s.textScale);
  const termScrollback = useSettings((s) => s.scrollback);
  const ptyAutocorrect = useSettings((s) => s.ptyAutocorrect);
  const setPtyAutocorrect = useSettings((s) => s.setPtyAutocorrect);
  const forceFitRef = useRef<() => void>(() => {});
  const scrollToEndRef = useRef<() => void>(() => {});
  const rowMeasureRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    const s0 = useSettings.getState();
    const term = new XTerm({ fontFamily: 'JetBrains Mono, monospace', fontSize: s0.fontSize * s0.textScale, theme: { ...useActiveTheme.getState().theme.terminal }, scrollback: s0.scrollback, convertEol: true, cursorBlink: true,
      // xterm's own handler asks confirm() and ignores every non-http link; a doc opens in the doc viewer, a web link in a new tab, the rest nothing.
      linkHandler: { allowNonHttpProtocols: true, activate: (_e, uri) => {
        const chips = docChipsRef.current;
        const act = chips.link!(uri);
        if (act.kind === 'doc') chips.onOpen(act.path, null);
        else if (act.kind === 'web') window.open(uri, '_blank', 'noopener,noreferrer');
      } } });
    const fit = new FitAddon();
    term.loadAddon(fit);

    // Windows/Linux clipboard. Stock xterm turns Ctrl+C / Ctrl+V into control bytes
    // before the browser can act, which reads as "copy paste is broken" to anyone
    // off a Mac. Ctrl+C with an active selection copies it instead of interrupting
    // (Windows Terminal / VS Code behavior); with no selection it stays SIGINT.
    // Ctrl+V and Ctrl+Shift+V are released to the browser (return false, no
    // preventDefault): the native paste lands in xterm's own paste listener, a path
    // that works even over plain http where navigator.clipboard does not exist.
    // Macs keep stock behavior — Cmd+C/Cmd+V never enter xterm's key handler.
    // Keys match by keyCode (67 = C, 86 = V), the field xterm itself maps Ctrl+letter
    // by, so a Cyrillic or Greek layout gets the same behavior as a Latin one.
    if (!isMacLike()) {
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown' || !ev.ctrlKey || ev.altKey || ev.metaKey) return true;
        if (!ev.shiftKey && ev.keyCode === 67 && term.hasSelection()) {
          ev.preventDefault();
          const text = term.getSelection();
          // xterm drops a selection only on typed input or a click. Left in place, every
          // later Ctrl+C would copy again and a runaway process could never be interrupted.
          term.clearSelection();
          // copyText's insecure-context fallback focuses an off-screen textarea and removes
          // it, which drops focus to <body>. Take focus back only then — never from an
          // element the user moved to while the write was pending.
          copyText(text)
            .catch((err) => window.alert(`Copy failed: ${err?.message ?? err}`))
            .finally(() => { if (!document.activeElement || document.activeElement === document.body) term.focus(); });
          return false;
        }
        if (ev.keyCode === 86) return false;
        return true;
      });
    }
    termRef.current = term;
    if (hostRef.current) { try { term.open(hostRef.current); } catch { /* jsdom */ } }

    // --- Progressive scrollback ---
    // The phone attaches with 256 KB and steps up on a scroll to the top. Desktop attaches with
    // 1 MB (W2-I; it was the full 4 MB ring on every connect) and uses the same step-up path.
    const initialReplay = isMobile ? INITIAL_REPLAY_MOBILE : INITIAL_REPLAY_DESKTOP;
    let currentReplay = initialReplay;
    let hasOlder = false;   // the ring holds more than we've currently loaded
    let rebuilding = false; // guards re-entry: one rebuild at a time
    // Absolute byte position, in the PTY's lifetime output, where the replay that
    // is CURRENTLY on screen begins (from the `dispatch:replay-meta` frame of
    // whichever socket owns the view). Infinity means "not known": a daemon older
    // than the meta protocol never sends the frame, and every comparison below must
    // then fall back to the pre-protocol behavior instead of blocking rebuilds.
    let displayedStartOffset = Number.POSITIVE_INFINITY;
    // Set once the daemon has PROVEN nothing older exists (a rebuild's replay began
    // at the same offset as, or later than, what is already displayed). A ring only
    // ever loses history, so this can never become false again — and it has to
    // survive the getScrollbackSize() writers below, which compare RETAINED bytes
    // and would otherwise keep re-offering a rebuild that can only abort again.
    let noOlderProven = false;
    // Live frames buffered while a rebuild is in flight, kept PER SOCKET. Both sockets are
    // subscribed to the same PTY during a rebuild (ws/terminal.ts registers one 'data' listener
    // per connection), so each chunk arrives TWICE — once on each. One shared buffer therefore
    // wrote every mid-rebuild chunk twice on success (doubled cursor/scroll-region escapes move
    // the cursor twice as far, so later output overwrites lines that should have survived —
    // "lines disappear"), and threw them ALL away on abort even though the old socket's view was
    // never reset, permanently losing up to REBUILD_TIMEOUT_MS of output. Splitting them lets
    // each outcome drain exactly the buffer that is contiguous with the view it keeps:
    //   success → drain pendingNew (continues the new socket's fresh replay snapshot)
    //   abort   → drain pendingOld (continues the old socket's still-intact view)
    let pendingOld: string[] = []; // frames from the CURRENT (primary) socket
    let pendingNew: string[] = []; // frames from the speculative rebuild socket
    // Aborts the in-flight rebuild, if any. Shared across the whole effect
    // lifetime (not just one startRebuild call) so ANY socket's onReset —
    // whichever one is currently authoritative — can abort a rebuild before
    // doing its own reset, even a LATER rebuild than the one active when that
    // socket was created.
    let activeRebuildAbort: ((opts?: { recoverBuffered?: boolean }) => void) | null = null;
    const openSockets = new Set<ReturnType<typeof socketFactory>>();
    const resyncSize = () => { if (term.cols && term.rows) sockRef.current?.resize(term.cols, term.rows); };

    // Shared reconnect handling for whichever socket is CURRENTLY authoritative
    // (the primary connection, or a rebuild's new socket once it has taken over
    // as primary): abort any in-flight rebuild FIRST — its speculative replay
    // write must never land on top of a screen that's about to be reset out
    // from under it, which is exactly how "duplicated or interleaved content"
    // happens — then do the normal reset + resize.
    const handleConnectionReset = () => {
      activeRebuildAbort?.();
      chunkTail = ''; // a new byte stream follows
      term.reset();
      resyncSize();
      // The server replays the whole scrollback next — land at the newest output, not at
      // whatever line the pre-reset viewport happened to sit on (see pinNextReplay).
      pinNextReplay = true;
    };

    let gotData = false;
    // A CLI thread must open showing its NEWEST output, the same way a Pretty thread does
    // (ChatView pins to the bottom via MessageScroller's defaultScrollPosition="end" plus its
    // post-mount backfill pin). Nothing did that here, so a PTY thread opened wherever xterm's
    // viewport happened to land after a large replay was written — usually the top, leaving the
    // reader to scroll down to catch up. Codex threads show this every time because they are
    // always PTY; Claude threads mostly hid it by running on the Pretty transport.
    //
    // Armed for the FIRST frame of the connection and re-armed on a reconnect (whose reset is
    // followed by a fresh full replay). Deliberately NOT set for ordinary live frames — that
    // would yank the viewport back down while the reader is deliberately scrolled up reading
    // history. The rebuild path owns its own anchor restore (finishRebuild) and never routes
    // through here, so the two can't fight.
    let pinNextReplay = true;
    // Every write goes through the gate, which knows whether the write xterm is parsing right now
    // is a REPLAY (the ring-buffer history a connection opens with). The history holds every
    // color, cursor and device query the CLI ever sent. Their answers were consumed long ago, so
    // answering them again makes the CLI read the reply as typing. The handlers below make xterm
    // skip its own answer while a replay parses; live queries are answered as before.
    //
    // Known limit: a query that is still unanswered at the very end of a replay (a CLI that
    // started before any viewer attached) is not answered either. The replay cannot tell it from
    // one whose answer was consumed, and answering a stale one is the bug this fixes.
    // The same goes for a query the CLI sent in the short window of a progressive-scrollback rebuild.
    const gate = createWriteGate(term);
    const stopSuppressingReplayQueries = suppressReplayedQueries(term, gate.parsingReplay);
    // The server sends no replay frame when its ring is empty (a new thread, a revived one). Then
    // the first frame is LIVE: the CLI's startup queries, which must be answered. An older daemon
    // does not say, so it keeps the rule that the first frame is the replay.
    const noReplayFollows = (m: { hasReplay?: boolean }) => { if (m.hasReplay === false) pinNextReplay = false; };
    // True while a reprint that began with a scrollback clear is still arriving and the reader
    // was at the bottom when it began (see SCROLLBACK_CLEAR).
    let followReprint = false;
    let reprintTimer: ReturnType<typeof setTimeout> | undefined;
    // The last bytes of the previous frame, so a clear split across two frames is still seen
    // (review round 1).
    let chunkTail = '';
    const endFollow = () => {
      followReprint = false;
      if (reprintTimer) { clearTimeout(reprintTimer); reprintTimer = undefined; }
    };
    // The "just show it" path: used for every socket's data whenever that data is
    // NOT part of an in-flight rebuild's buffered catch-up — i.e. the original
    // connection's normal traffic, and any survivor-of-a-rebuild socket once it
    // has become primary again.
    const attachLive = (chunk: string) => {
      const clearIn = (chunkTail + chunk).includes(SCROLLBACK_CLEAR);
      chunkTail = (chunkTail + chunk).slice(-(SCROLLBACK_CLEAR.length - 1));
      if (clearIn) {
        const b = term.buffer.active;
        if (followReprint || b.viewportY >= b.baseY) followReprint = true;
      }
      if (followReprint) {
        if (reprintTimer) clearTimeout(reprintTimer);
        reprintTimer = setTimeout(() => {
          reprintTimer = undefined;
          followReprint = false;
          if (!disposed) scrollToEndRef.current();
        }, REPRINT_QUIET_MS);
      }
      const pinReplay = pinNextReplay;
      if (pinReplay || followReprint) {
        pinNextReplay = false;
        // In the write CALLBACK: xterm parses asynchronously, so scrolling synchronously after
        // write() would target the PRE-write buffer and land short of the end. A reprint follow
        // that the reader ended in the meantime does not pin.
        const afterWrite = () => { if (!disposed && (pinReplay || followReprint)) scrollToEndRef.current(); };
        gate.write(chunk, pinReplay, afterWrite);
      } else {
        gate.write(chunk, false);
      }
      if (!gotData) {
        gotData = true;
        setLoading(false);
        // The very first frame is the initial replay. Ask the server whether the
        // ring actually holds more than we requested — if so, a scroll-to-top can
        // later offer to rebuild for it. Deliberately best-effort: a failure here
        // just means scrolling up won't offer more, not a broken attach.
        void api.getScrollbackSize(terminalId).then((total) => {
          if (disposed) return;
          hasOlder = !noOlderProven && total > currentReplay;
        }).catch(() => { /* best-effort */ });
      }
    };

    // True when xterm's line buffer is at (or within a hair of) its configured
    // ceiling — see SCROLLBACK_CAP_FRACTION. `options.scrollback` is undefined only
    // before the terminal is configured, in which case there is nothing to compare.
    const atScrollbackCap = () => {
      const cap = term.options.scrollback;
      if (typeof cap !== 'number' || cap <= 0) return false;
      return term.buffer.active.length >= cap * SCROLLBACK_CAP_FRACTION;
    };

    function maybeStartRebuild() {
      if (disposed || rebuilding || !hasOlder) return;
      if (currentReplay >= MAX_REPLAY) return;
      if (term.buffer.active.viewportY !== 0) return;
      // A bigger replay cannot show more than xterm is willing to keep. Stop
      // offering it rather than paying a reset + viewport jump for zero new lines.
      if (atScrollbackCap()) { hasOlder = false; return; }
      startRebuild();
    }

    // Rebuild ordering (load-bearing — see the design doc): open the NEW socket
    // first; buffer any live frames arriving on EITHER socket while the rebuild
    // is in flight; when the new socket's replay frame lands, capture the old
    // length/viewportY BEFORE reset, reset, write the replay, then write the
    // buffered live frames (in arrival order) AFTER it; restore the scroll
    // anchor from the POST-write length (measured in the write callback — xterm's
    // write() is async, so reading buffer.active.length synchronously after
    // calling it would still see the pre-write value); close the OLD socket last.
    function startRebuild() {
      rebuilding = true;
      setLoadingOlder(true);
      pendingOld = [];
      pendingNew = [];
      const nextSize = nextReplayStep(currentReplay);
      const oldSock = sockRef.current!;
      let gotReplay = false;
      let oldLength = 0;
      let oldViewportY = 0;
      // Where the new socket's replay begins, from its meta frame. Undefined when
      // the daemon does not speak the meta protocol — then the offset check is
      // skipped entirely and the rebuild behaves exactly as it did before.
      let newStartOffset: number | undefined;
      // Set by abort(): the discarded socket may still deliver frames the server had
      // already queued before our close() took effect. They belong to a snapshot we
      // threw away — resetting the screen for them would destroy the surviving view.
      let aborted = false;
      // True once THIS attempt has finished or aborted — guards re-entrant
      // callbacks (our own newSock.close() below still fires the socket's
      // onClose once more; a stale rebuildTimer could in principle still be
      // pending) so an attempt can only ever be settled one way, once.
      let settled = false;
      let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

      const clearRebuildTimer = () => { if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = undefined; } };

      const drainPending = () => {
        if (disposed || settled) return;
        if (pendingNew.length === 0) { finishRebuild(); return; }
        const chunk = pendingNew.shift()!;
        gate.write(chunk, false, drainPending);
      };

      const finishRebuild = () => {
        if (disposed || settled) return;
        settled = true;
        clearRebuildTimer();
        activeRebuildAbort = null;
        // The old socket's buffered frames are deliberately dropped on SUCCESS: its view is
        // being replaced wholesale, and the same bytes already reached us on the new socket
        // (both were subscribed to the one PTY) — writing them too is what doubled them.
        pendingOld = [];
        const newLength = term.buffer.active.length;
        term.scrollToLine(Math.max(0, oldViewportY + (newLength - oldLength)));
        sockRef.current = newSock;
        openSockets.delete(oldSock);
        oldSock.close();
        currentReplay = nextSize;
        // The new socket's window is now the one on screen.
        if (newStartOffset !== undefined) displayedStartOffset = newStartOffset;
        // Keep the surviving socket's RECONNECT size in step with what we display.
        // It was opened at nextSize, so this is belt-and-braces — but the whole
        // reconnect-shrinks-history bug came from a replay size drifting out of
        // sync with the view, so state it explicitly instead of relying on that.
        newSock.setReplayBytes?.(nextSize);
        rebuilding = false;
        setLoadingOlder(false);
        void api.getScrollbackSize(terminalId).then((total) => {
          if (disposed) return;
          hasOlder = !noOlderProven && currentReplay < MAX_REPLAY && total > currentReplay;
        }).catch(() => { hasOlder = false; });
      };

      // Abort a rebuild that failed or stalled before delivering its replay:
      // undo NOTHING that is already visible — the old socket and current
      // terminal content are left exactly as they were — just discard the
      // speculative new socket, and clear the guard so a later scroll-to-top can
      // try again. This is the fix for the worst failure mode: a dead new socket
      // must never leave "load older" permanently stuck for the rest of the session.
      //
      // The old socket's frames withheld during the attempt MUST still be written: its view
      // was never reset, so they are the missing continuation of what the reader is looking
      // at. Discarding them (the previous behavior) silently lost every byte the PTY emitted
      // during the attempt — up to REBUILD_TIMEOUT_MS (10s) on a stall, and unrecoverable
      // because nothing replays afterwards. The speculative socket's own buffer IS dropped:
      // it belongs to a snapshot that is being thrown away.
      const abort = (opts?: { recoverBuffered?: boolean }) => {
        if (settled) return;
        settled = true;
        aborted = true;
        clearRebuildTimer();
        activeRebuildAbort = null;
        // Only when the OLD view survives and simply continues. The reset-driven and unmount
        // callers pass nothing: a full replay is already inbound (and will contain these bytes),
        // or the terminal is going away — replaying here would duplicate or waste.
        // Written before `rebuilding` clears, so xterm's ordered write queue keeps these
        // ahead of any frame that lands immediately after.
        if (opts?.recoverBuffered) for (const chunk of pendingOld) gate.write(chunk, false);
        pendingOld = [];
        pendingNew = [];
        rebuilding = false;
        setLoadingOlder(false);
        openSockets.delete(newSock);
        newSock.close();
      };
      activeRebuildAbort = abort;

      // Silent-hang guard: the new socket connects but the replay frame never
      // arrives (e.g. server never responds). Cleared the instant the replay
      // frame lands — see onData below.
      rebuildTimer = setTimeout(() => abort({ recoverBuffered: true }), REBUILD_TIMEOUT_MS);

      const newSock = socketFactory({
        terminalId,
        replayBytes: nextSize,
        // Same declared size as the primary socket: a rebuild whose width silently
        // differed from the pty's would replay rewrapped noise (defined below;
        // rebuilds only ever run after the primary connect, so it's initialized).
        size: () => currentSize(),
        // Arrives BEFORE the replay bytes, which is the whole point: it lets us
        // decide whether this window is worth showing before anything is destroyed.
        onMeta: (m) => {
          if (disposed || aborted) return;
          // Already promoted to primary — this is a later reconnect's replay, which
          // replaces the view wholesale, so its offset is what's now on screen.
          if (settled) { displayedStartOffset = m.startOffset; noReplayFollows(m); return; }
          // A window that starts at or after what we already show contains nothing
          // older. Rebuilding would reset the screen and jump the viewport to buy
          // the reader exactly zero extra history, so keep the current view and
          // stop offering more. Only a STRICTLY lower offset may replace it.
          if (m.startOffset >= displayedStartOffset) {
            noOlderProven = true;
            hasOlder = false;
            abort({ recoverBuffered: true });
            return;
          }
          newStartOffset = m.startOffset;
        },
        onData: (chunk) => {
          if (disposed || aborted) return;
          if (!gotReplay) {
            gotReplay = true;
            clearRebuildTimer();
            // Capture the anchor BEFORE reset wipes it.
            oldLength = term.buffer.active.length;
            oldViewportY = term.buffer.active.viewportY;
            term.reset();
            gate.write(chunk, true, drainPending);
            return;
          }
          if (rebuilding) { pendingNew.push(chunk); return; }
          attachLive(chunk);
        },
        // Before the replay lands, a reset here means THIS socket dropped and
        // reconnected without ever completing the rebuild — abort exactly like
        // an error/close/timeout (no term.reset(): the old view must survive).
        // After it's settled (this socket has already become primary), it's an
        // ordinary later reconnect — route through the shared handler.
        onReset: () => { if (settled) { handleConnectionReset(); return; } abort({ recoverBuffered: true }); },
        // The new socket errors or closes before ever delivering a replay —
        // same abort. (The socket abstraction has no separate error event: a
        // WebSocket error always surfaces via close, so this one hook covers
        // both triggers.) A close AFTER the replay already landed is ignored
        // here — that socket's own reconnect/onReset path takes over instead.
        onClose: () => { if (!gotReplay) abort({ recoverBuffered: true }); },
      });
      openSockets.add(newSock);
    }

    let lastW = -1, lastH = -1, lastCols = -1, lastRows = -1, pending = false;
    // True once a REAL fit has happened (non-zero host box) — the gate for declaring
    // a size to the server. Without it, currentSize() would report xterm's 80×24
    // default and the server would resize the pty to a size nobody renders at.
    let fitted = false;
    const applyFit = (opts?: { alwaysNotify?: boolean; repaint?: boolean }) => {
      const el = hostRef.current;
      // Skip while backgrounded: iOS reports a collapsed visual viewport and a
      // fit here would tell Grok it is 10×8. We refit on the way back instead.
      if (disposed || !el || document.hidden) return;
      const w = el.clientWidth, h = el.clientHeight;
      if (w === 0 || h === 0) return;
      try { fit.fit(); } catch { return; }
      fitted = true;
      lastW = w; lastH = h;
      const changed = term.cols !== lastCols || term.rows !== lastRows;
      if (changed || opts?.alwaysNotify) {
        lastCols = term.cols; lastRows = term.rows;
        sockRef.current?.resize(term.cols, term.rows, opts?.repaint ? { repaint: true } : undefined);
      }
      rowMeasureRef.current();
    };
    const scheduleFit = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const el = hostRef.current;
        if (disposed || !el) return;
        if (el.clientWidth === lastW && el.clientHeight === lastH) return;
        applyFit();
      });
    };
    // Fit BEFORE the socket opens (the host is laid out by effect time), so the
    // connect below can declare the real viewer size and the server can resize the
    // pty ahead of reading the replay — the width-scramble fix. sockRef is still
    // null here, so this fit sends no resize message; the URL params carry it.
    applyFit();
    /** The size the socket declares on every (re)connect; null until truly fitted. */
    const currentSize = () => (fitted && term.cols > 0 && term.rows > 0 ? { cols: term.cols, rows: term.rows } : null);

    const sock = socketFactory({
      terminalId,
      replayBytes: initialReplay,
      size: currentSize,
      // This socket owns the view, so its replay window IS what the reader sees —
      // on the first connect and again after every reconnect-driven replay.
      onMeta: (m) => { if (disposed) return; displayedStartOffset = m.startOffset; noReplayFollows(m); },
      onData: (chunk) => {
        if (disposed) return;
        if (rebuilding) { pendingOld.push(chunk); return; }
        attachLive(chunk);
      },
      // On reconnect the server replays the scrollback — clear first so it
      // lands clean, then re-sync the PTY size to this view. If a progressive-
      // scrollback rebuild is in flight when this fires, abort it first (see
      // handleConnectionReset) so its speculative write can't land on/after
      // this reset and duplicate or interleave content.
      onReset: handleConnectionReset,
    });
    openSockets.add(sock);
    sockRef.current = sock;
    // Hide the loading indicator once content arrives (or after a short grace
    // period so a genuinely-quiet terminal doesn't spin forever).
    const loadTimer = setTimeout(() => setLoading(false), 6000);
    term.onData((d) => sockRef.current?.send(d));

    // Force a refit even when the container size is unchanged (font-size, or
    // returning from background — iOS often restores the same box).
    forceFitRef.current = () => applyFit({ alwaysNotify: true });

    requestAnimationFrame(() => { if (!disposed) { scheduleFit(); try { term.focus(); } catch { /* jsdom */ } } });

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && hostRef.current) {
      ro = new ResizeObserver(() => scheduleFit());
      ro.observe(hostRef.current);
    }
    window.addEventListener('resize', scheduleFit);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', scheduleFit);
    // Coming back also asks for a full redraw (2026-11-06): another device may have resized the
    // same terminal meanwhile, and the TUI's frames drawn at that width left this screen scrambled.
    const onForeground = () => {
      if (document.hidden) return;
      // iOS applies the restored layout a frame after visibilitychange.
      requestAnimationFrame(() => { if (!disposed) applyFit({ alwaysNotify: true, repaint: true }); });
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('focus', onForeground);
    window.addEventListener('pageshow', onForeground);

    // --- Sub-pixel smooth touch scrolling (mobile) ---
    // xterm's DOM renderer only repaints in whole rows, so every scroll path it
    // offers (its own touch handler, scrollLines, viewport.scrollTop) makes the
    // text stick then jump ~1 row (≈17px). We own the gesture and split scrolling
    // into: term.scrollLines for whole rows + a translate3d on .xterm-screen for
    // the sub-row remainder, so the text tracks the finger continuously. Two
    // things that previously made this "really bad": (1) reading row height with
    // getBoundingClientRect every frame (a layout reflow per frame) — now cached;
    // (2) applying the transform synchronously after scrollLines, a frame before
    // xterm repaints the new row — torn frame / flicker. We now apply the
    // remainder transform inside term.onRender so it is locked to the repaint.
    const host = hostRef.current;
    const viewportEl = () => host?.querySelector('.xterm-viewport') as HTMLElement | null;
    const screenEl = () => host?.querySelector('.xterm-screen') as HTMLElement | null;
    const xtermEl = host?.querySelector('.xterm') as HTMLElement | null;
    if (xtermEl) { xtermEl.style.overflow = 'hidden'; xtermEl.style.touchAction = 'none'; }
    if (host) host.style.touchAction = 'none';
    // .xterm-viewport is overflow-y:scroll, which makes its overflow-x compute to
    // auto — on iOS that yields a phantom horizontal scroll/rubber-band. Pin it.
    { const vp = viewportEl(); if (vp) { vp.style.overflowX = 'hidden'; vp.style.touchAction = 'none'; } }
    // On touch devices, forbid text selection across the whole terminal subtree.
    // Otherwise a drag that starts over text begins an iOS selection instead of
    // scrolling (xterm's accessibility-tree overlay is user-select:text), which
    // is why scrolling only felt right when the finger was over empty space.
    if (isMobile && host) host.classList.add('dispatch-noselect');
    { const s = screenEl(); if (s) { s.style.background = 'var(--term-background)'; s.style.willChange = 'transform'; } }

    let rowHeight = Math.ceil((term.options.fontSize ?? 13) * 1.2);
    rowMeasureRef.current = () => { const r = host?.querySelector('.xterm-rows') as HTMLElement | null; if (r && r.children.length) rowHeight = r.getBoundingClientRect().height / r.children.length; };

    let subPx = 0;       // sub-row remainder, applied as a screen translate
    let overscroll = 0;  // signed px pulled past an end (>0 past bottom) — the rubber-band
    let tuiAcc = 0;      // leftover px toward the next mouse-wheel tick (alt-screen TUIs)
    const applyTransform = () => { const s = screenEl(); if (!s) return; const ty = -subPx - overscroll; s.style.transform = ty ? `translate3d(0,${ty}px,0)` : ''; };
    const offRender = term.onRender(() => applyTransform()); // keep the offset locked to each repaint

    // A pull past the bottom (overscroll > 0) is still "at bottom" — keep the
    // jump-to-latest arrow hidden during that rubber-band. A pull past the top
    // (overscroll < 0) is genuinely not at bottom, so it falls through.
    const viewportAtBottom = () => {
      const vp = viewportEl();
      if (!vp) return true;
      if (overscroll > 0) return true;
      return vp.scrollHeight - vp.clientHeight - vp.scrollTop < 4 && subPx === 0 && overscroll === 0;
    };
    const updateAtBottom = () => setAtBottom(viewportAtBottom());

    let inertiaId = 0, springId = 0;
    let lastY = 0, lastT = 0, vel = 0, startY = 0, moved = false;
    const stopInertia = () => { if (inertiaId) { cancelAnimationFrame(inertiaId); inertiaId = 0; } };
    const stopSpring = () => { if (springId) { cancelAnimationFrame(springId); springId = 0; } };
    const springBack = () => {
      stopSpring();
      const step = () => {
        overscroll *= 0.8;
        if (Math.abs(overscroll) < 0.5) { overscroll = 0; springId = 0; applyTransform(); updateAtBottom(); return; }
        applyTransform();
        springId = requestAnimationFrame(step);
      };
      springId = requestAnimationFrame(step);
    };
    const ptyScroll = () => shouldPtyScroll(term.buffer.active.type, typeRef.current);
    const scrollByPx = (px: number) => {
      const h = rowHeight || 17;
      // Grok (always) and any alt-screen TUI own their own scrollback. Mouse-wheel
      // CSI is ignored while Grok's prompt is focused — which is the idle state —
      // so we send Page Up/Down, which the TUI documents as working in both
      // focus modes. The normal-buffer xterm path stays for shell / --minimal.
      if (ptyScroll()) {
        const next = consumePageTicks(tuiAcc, px);
        tuiAcc = next.accPx;
        if (next.seq) sockRef.current?.send(next.seq);
        return;
      }
      // Already rubber-banded: deeper pull resists (×0.45), pulling back releases
      // it 1:1; snap to 0 when it crosses neutral. Never touches content here.
      if (overscroll !== 0) {
        const prev = overscroll;
        overscroll += ((overscroll > 0) === (px > 0)) ? px * 0.45 : px;
        if ((prev > 0) !== (overscroll > 0)) overscroll = 0;
        overscroll = Math.max(-150, Math.min(150, overscroll));
        applyTransform(); updateAtBottom(); return;
      }
      const b0 = term.buffer.active;
      // Flush against an end and still pushing further → start a rubber-band
      // instead of jittering the screen against the wall.
      if ((b0.viewportY >= b0.baseY && subPx === 0 && px > 0) || (b0.viewportY <= 0 && subPx === 0 && px < 0)) {
        overscroll = Math.max(-150, Math.min(150, px * 0.45));
        applyTransform(); updateAtBottom(); return;
      }
      // Normal content scroll.
      const newSub = subPx + px;
      const lines = Math.floor(newSub / h);
      let rem = newSub - lines * h; // remainder in [0, h)
      const before = b0.viewportY;
      if (lines !== 0) term.scrollLines(lines);
      const b = term.buffer.active;
      // Never translate into empty space past the ends — this is the jitter fix
      // (the clamp now runs on EVERY move, not only when a whole row commits).
      if (b.viewportY >= b.baseY) rem = 0;                              // flush at the last line
      else if (b.viewportY <= 0 && b.viewportY === before && lines < 0) rem = 0; // flush at the top
      subPx = rem;
      if (b.viewportY === before) applyTransform(); // no repaint coming → apply now; else onRender does
      updateAtBottom();
    };
    const onTouchStart = (e: TouchEvent) => { endFollow(); stopInertia(); stopSpring(); lastY = e.touches[0].clientY; startY = lastY; moved = false; lastT = performance.now(); vel = 0; };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY, now = performance.now();
      const dy = lastY - y, dt = now - lastT;
      lastY = y; lastT = now;
      if (Math.abs(y - startY) > 6) moved = true;
      if (dt > 0) vel = dy / dt;
      scrollByPx(dy);
      e.preventDefault();
    };
    const onTouchEnd = () => {
      if (ptyScroll()) { tuiAcc = 0; return; } // page keys are discrete — no inertial extra pages
      if (overscroll !== 0) { springBack(); return; } // released mid rubber-band → bounce home
      if (!moved) return; // terminal is non-interactive on mobile — a tap does nothing (type via the input bar)
      let v = Math.max(-12, Math.min(12, vel));
      if (Math.abs(v) < 0.03) return;
      let prev = performance.now();
      const step = () => {
        const now = performance.now(); const dt = Math.max(1, now - prev); prev = now;
        v *= Math.pow(0.95, dt / 16);
        if (Math.abs(v) < 0.02) { inertiaId = 0; return; }
        scrollByPx(v * dt);
        if (overscroll !== 0) { inertiaId = 0; springBack(); return; } // fling hit an end → bounce
        inertiaId = requestAnimationFrame(step);
      };
      inertiaId = requestAnimationFrame(step);
    };
    // Attach to a STABLE transparent overlay, never to the xterm content: the DOM
    // renderer destroys the <span> under the finger on every repaint, which makes
    // iOS fire touchcancel and abort the gesture (scrolling died "after one line"
    // whenever the finger was over text). The overlay never changes, so the touch
    // sequence survives the repaints.
    const touchSurface = scrollOverlayRef.current;
    if (touchSurface) {
      touchSurface.addEventListener('touchstart', onTouchStart, { passive: true });
      touchSurface.addEventListener('touchmove', onTouchMove, { passive: false });
      touchSurface.addEventListener('touchend', onTouchEnd, { passive: true });
      touchSurface.addEventListener('touchcancel', onTouchEnd, { passive: true });
    }

    // The reader's own scroll input ends a reprint follow at once (see SCROLLBACK_CLEAR): the
    // desktop wheel and a press on the scrollbar land inside the host; touch ends it in onTouchStart.
    const onUserScrollInput = () => endFollow();
    // xterm's own keyboard scrolling (Shift+PageUp/PageDown/Home/End) ends it too (review round 1).
    // Ordinary typing does not: a reader typing the next prompt is still at the bottom.
    const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End']);
    const onKeyScroll = (e: KeyboardEvent) => { if (e.shiftKey && SCROLL_KEYS.has(e.key)) endFollow(); };
    host?.addEventListener('wheel', onUserScrollInput, { passive: true, capture: true });
    host?.addEventListener('pointerdown', onUserScrollInput, { passive: true, capture: true });
    host?.addEventListener('keydown', onKeyScroll, { capture: true });
    // During a reprint follow, the browser's own scroll event (its scrollTop clamp after the
    // scrollback clear) puts the view back at the bottom instead of leaving it where it landed.
    const onViewportScroll = () => { if (followReprint) scrollToEndRef.current(); else updateAtBottom(); };
    const vp0 = viewportEl();
    vp0?.addEventListener('scroll', onViewportScroll, { passive: true });
    const offScroll = term.onScroll(() => { updateAtBottom(); maybeStartRebuild(); });
    updateAtBottom();
    scrollToEndRef.current = () => { stopInertia(); stopSpring(); subPx = 0; overscroll = 0; applyTransform(); term.scrollToBottom(); updateAtBottom(); };

    void api.getTerminal(terminalId).then((m) => {
      if (disposed) return;
      setMeta(m);
    });

    return () => {
      disposed = true;
      clearTimeout(loadTimer);
      stopInertia();
      stopSpring();
      if (touchSurface) {
        touchSurface.removeEventListener('touchstart', onTouchStart);
        touchSurface.removeEventListener('touchmove', onTouchMove);
        touchSurface.removeEventListener('touchend', onTouchEnd);
        touchSurface.removeEventListener('touchcancel', onTouchEnd);
      }
      endFollow();
      host?.removeEventListener('wheel', onUserScrollInput, { capture: true });
      host?.removeEventListener('pointerdown', onUserScrollInput, { capture: true });
      host?.removeEventListener('keydown', onKeyScroll, { capture: true });
      vp0?.removeEventListener('scroll', onViewportScroll);
      offScroll.dispose();
      offRender.dispose();
      stopSuppressingReplayQueries();
      ro?.disconnect();
      window.removeEventListener('resize', scheduleFit);
      vv?.removeEventListener('resize', scheduleFit);
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('focus', onForeground);
      window.removeEventListener('pageshow', onForeground);
      // If a rebuild is mid-flight at unmount time, abort it first so its 10s
      // stall timer is cleared here rather than firing up to 10s after unmount.
      activeRebuildAbort?.();
      // Close whatever socket(s) are currently open — if a rebuild is mid-flight
      // at unmount time, both the old and the new socket are in this set.
      openSockets.forEach((s) => s.close());
      openSockets.clear();
      term.dispose();
      sockRef.current = null;
      termRef.current = null;
    };
  }, [terminalId, socketFactory]);

  // The theme's terminal palette, live: a theme change (Settings → Appearance, or the device
  // switching light/dark under 'system') repaints the running terminal.
  const termPalette = useActiveTheme((s) => s.theme.terminal);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try { term.options.theme = { ...termPalette }; } catch { /* terminal not fully initialised (e.g. jsdom) */ }
  }, [termPalette]);

  // Apply font-size / text scale / scrollback changes live to the running terminal.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      term.options.fontSize = termFontSize * termTextScale;
      term.options.scrollback = termScrollback;
      forceFitRef.current();
    } catch { /* terminal not fully initialised (e.g. jsdom) */ }
  }, [termFontSize, termTextScale, termScrollback]);

  // Picked, dropped and pasted images upload to the project inbox with a progress tile each
  // (UploadTray); once one lands, its path goes to the agent as context.
  const uploader = useInboxUploads(meta?.sessionId, async (res) => { await api.sendFileReference(terminalId, res.path, 'agent-context'); });
  const uploadImage = (file: File) => uploader.start(file);
  function onFiles(files: FileList | null) {
    if (files) for (const f of Array.from(files)) void uploadImage(f);
  }

  // Mobile input: the terminal is read-only to touch (you can only scroll it),
  // so typing happens here and is sent to the PTY as a submitted line. Send the
  // text and the Enter as SEPARATE writes — "text\r" in one write makes the agent
  // TUI treat the \r as a literal newline (message staged, not submitted); a
  // standalone Enter is recognized as submit.
  function sendMobileInput() {
    const v = mobileInput;
    if (!v) return;
    sockRef.current?.send(v);
    setTimeout(() => sockRef.current?.send('\r'), 80);
    clearMobileInput();
  }

  const { slash: slashCmds } = keysFor(meta?.type);
  const slashFilter = slashQuery.trim().toLowerCase();
  const slashResults = slashFilter
    ? slashCmds.filter((c) => c.cmd.toLowerCase().includes(slashFilter) || c.desc.toLowerCase().includes(slashFilter))
    : slashCmds;
  const closeSlash = () => { setSlashOpen(false); setSlashQuery(''); };

  return (
    <div
      onMouseDown={() => { if (!isMobile) { try { termRef.current?.focus(); } catch { /* */ } } }}
      onDragOver={(e) => { e.preventDefault(); setDrop(true); }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => { e.preventDefault(); setDrop(false); onFiles(e.dataTransfer.files); }}
      onPaste={(e) => { const f = Array.from(e.clipboardData?.files ?? []); if (f.length) { e.preventDefault(); f.forEach((x) => void uploadImage(x)); } }}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', background: isMobile ? 'var(--color-pane)' : 'var(--color-terminal)', position: 'relative' }}
    >
      {/* The xterm host is absolutely positioned so the terminal's own size never
          drives the flex layout width (which previously blew the column out).
          On mobile the terminal is a rounded card with a thin frame (the pane bg
          shows through the 2px margin). */}
      <div data-testid="term-frame" style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', background: isMobile ? 'var(--color-terminal)' : undefined, ...(isMobile && !grokFlush ? { margin: '2px 8px', borderRadius: 'var(--radius-xl)' } : {}) }}>
        {/* inset (not padding): FitAddon measures the host's width, and padding on
            the host makes it over-count columns so the right edge clips. On mobile
            the right inset is trimmed: xterm's column quantization + scrollbar leave
            ~7px unused on the right, so a smaller right inset re-centres the text
            (and gains a column or two of width). Grok is a full-screen TUI — flush
            it so the card chrome does not steal columns. */}
        <div ref={hostRef} data-testid="term-host" style={{ position: 'absolute', ...(grokFlush ? { inset: 0 } : isMobile ? { top: 0, bottom: 12, left: 3, right: 3 } : { inset: 15 }) }} />
        {/* Stable transparent touch surface (mobile): the gesture lands here, never
            on the xterm spans that get destroyed on every repaint. Sits above the
            terminal but below the jump-to-latest button. */}
        {isMobile && <div ref={scrollOverlayRef} data-testid="term-scroll-overlay" style={{ position: 'absolute', inset: 0, zIndex: 3, touchAction: 'none' }} />}
        {loading && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-terminal)', pointerEvents: 'none' }}>
            <Spinner size={26} />
          </div>
        )}
        {!atBottom && (
          <button
            title="Scroll to latest"
            onClick={() => scrollToEndRef.current()}
            style={{ position: 'absolute', right: 16, bottom: 16, width: 42, height: 42, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', color: 'var(--color-on-accent)', border: 'none', boxShadow: '0 8px 22px -6px var(--color-shadow)', cursor: 'pointer', zIndex: 6 }}
          >
            <CaretDoubleDown size={19} weight="bold" />
          </button>
        )}
        {loadingOlder && (
          <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 6, background: 'color-mix(in srgb, var(--color-base) 85%, transparent)', color: 'var(--color-accent)', fontSize: fontVar(12), fontWeight: 500, padding: '5px 11px', borderRadius: 'var(--radius-md)', pointerEvents: 'none' }}>Loading earlier output…</div>
        )}
        {drop && (
          <div style={{ position: 'absolute', inset: 8, border: '2px dashed var(--color-accent)', borderRadius: 'var(--radius-md)', background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', color: 'var(--color-accent)', fontSize: fontVar(14), fontWeight: 600 }}>Drop image to send to the agent</div>
        )}
        {note && (
          <div style={{ position: 'absolute', left: 14, bottom: 14, zIndex: 6, background: 'color-mix(in srgb, var(--color-base) 85%, transparent)', color: 'var(--color-accent)', fontSize: fontVar(12), fontWeight: 500, padding: '5px 11px', borderRadius: 'var(--radius-md)', pointerEvents: 'none' }}>{note}</div>
        )}
      </div>
      {/* Safety net: a needs_you question a CLI thread declared via report_status lands only on
          the status channel — surface it as a strip so it isn't invisible in the terminal. It sits
          under the terminal with the footer (a CLI AI thread's outcome card), where a Pretty thread
          shows them, in a footer that holds its height during a turn (see TurnFooter). */}
      {uploader.uploads.length > 0 && (
        <div style={{ padding: '6px 10px 0', background: isMobile ? 'var(--color-pane)' : undefined, flexShrink: 0 }}>
          <UploadTray uploads={uploader.uploads} onCancel={uploader.cancel} />
        </div>
      )}
      <TurnFooter terminalId={terminalId}>
        {footer}
      </TurnFooter>
      {isMobile && (
        /* The shared composer (composer/PillComposer.tsx). The keys that used to sit in an
           always-on row above it (2026-11-05) are in a Keys sheet behind the +, with more per
           harness, which gives the terminal that line back. */
        /* The dock keeps the empty box's height in the column; the box sits on its bottom edge and
           grows upward OVER the terminal, so typing never resizes (and redraws) the terminal
           (owner, 2026-11-07). A handle on a tall box shrinks it to two lines and back. */
        <div data-testid="term-composer-dock" style={{ position: 'relative', flexShrink: 0, height: dockH ?? 'calc(72px + var(--composer-safe-bottom, env(safe-area-inset-bottom)))' }}>
        <div ref={composerOverlayRef} data-testid="term-composer-overlay" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 9, padding: '4px 8px 8px', paddingBottom: 'calc(8px + var(--composer-safe-bottom, env(safe-area-inset-bottom)))', }}>
          {keysOpen && <KeysPager pages={keyPages(sheetKeysFor(meta?.type))} onKey={(seq) => sockRef.current?.send(seq)} onClose={() => setKeysOpen(false)} />}
          <input ref={termFileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { onFiles(e.target.files); e.currentTarget.value = ''; }} />
          <PillComposer
            pluginContext={{ surface: 'terminal', terminalId: terminalId }}
            floating={tall}
            handle={tall ? (
            <button type="button" aria-label="Resize the message box" title="Drag to resize"
              // Keep the pointer while the finger drags off the handle; the box follows it live.
              onPointerDown={(e) => {
                const ta = composerOverlayRef.current?.querySelector('textarea');
                dragStart.current = { y: e.clientY, h: ta ? (parseFloat(ta.style.height) || ta.offsetHeight) : TWO_LINES };
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
              }}
              onPointerMove={(e) => {
                const d = dragStart.current;
                if (!d) return;
                setBoxH(Math.min(Math.round(window.innerHeight * 0.5), Math.max(TWO_LINES, d.h - (e.clientY - d.y))));
              }}
              onPointerUp={() => { dragStart.current = null; }}
              onPointerCancel={() => { dragStart.current = null; }}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                e.preventDefault();
                const ta = composerOverlayRef.current?.querySelector('textarea');
                const h = boxH ?? (ta ? parseFloat(ta.style.height) || ta.offsetHeight : TWO_LINES);
                setBoxH(Math.min(Math.round(window.innerHeight * 0.5), Math.max(TWO_LINES, h + (e.key === 'ArrowUp' ? 22 : -22))));
              }}
              style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: 64, height: 16, margin: 0, padding: 0, background: 'none', border: 'none', cursor: 'ns-resize', touchAction: 'none' }}>
              <span aria-hidden style={{ width: 36, height: 4, borderRadius: 'var(--radius-pill)', background: 'var(--color-text-tertiary)', opacity: 0.6 }} />
            </button>
            ) : undefined}
            value={mobileInput}
            onChange={setMobileInput}
            onSend={sendMobileInput}
            canSend={!!mobileInput}
            placeholder="Message or /command"
            onAddFile={() => termFileInputRef.current?.click()}
            afterPlus={(
              <button type="button" data-keys-toggle aria-label="Keys" title="Keys" aria-pressed={keysOpen} aria-expanded={keysOpen}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setKeysOpen((o) => !o)}
                style={{ flex: 'none', width: 40, height: 40, padding: 0, borderRadius: '50%', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                  background: keysOpen ? 'var(--color-hover)' : 'transparent', color: keysOpen ? 'var(--color-accent)' : 'var(--color-text-primary)' }}>
                <Keyboard size={22} />
              </button>
            )}
            menuExtra={(close) => (
              <div style={{ borderBottom: '1px solid var(--color-border)', marginBottom: 4, paddingBottom: 4 }}>
                {slashCmds.length > 0 && (
                  <button type="button" style={inputMenuRow()} onClick={() => { close(); setSlashQuery(''); setSlashOpen(true); }}>
                    <span style={{ width: 18, textAlign: 'center', font: `600 ${fontVar(16)} var(--font-mono)`, color: 'var(--color-accent)' }}>/</span> Slash commands
                  </button>
                )}
                {/* Spelling help for the box: on for prose, off for a run of shell commands. */}
                <button type="button" aria-label="Autocorrect" aria-pressed={ptyAutocorrect} style={inputMenuRow()}
                  onClick={() => setPtyAutocorrect(!ptyAutocorrect)}>
                  <span style={{ width: 18, textAlign: 'center', font: `600 ${fontVar(13)} var(--font-mono)`, color: ptyAutocorrect ? 'var(--color-accent)' : 'var(--color-text-tertiary)', textDecoration: ptyAutocorrect ? 'none' : 'line-through' }}>Aa</span>
                  Autocorrect {ptyAutocorrect ? 'on' : 'off'}
                </button>
              </div>
            )}
            dictation={dictation}
            sttConfigured={sttConfigured}
            /* Prose, not a shell prompt: spelling help defaults on (the menu's toggle turns it
               off). autoCapitalize stays off so `git`, `rg` and paths are not capitalised, and
               autoComplete stays off so form autofill never offers a value. */
            textareaProps={{ autoCapitalize: 'off', autoComplete: 'off', autoCorrect: ptyAutocorrect ? 'on' : 'off', spellCheck: ptyAutocorrect }}
            maxHeight={boxH ?? undefined}
            onTallChange={setTall}
            mobile
          />
        </div>
        </div>
      )}
      {/* Slash-command sheet. Portaled to <body> so position:fixed isn't trapped
          by the mobile slide-rail's transform (which would shift it off-screen). */}
      {/* Slash commands: the shared slide-up sheet. */}
      <Modal open={isMobile && slashOpen} sheet title="Slash commands" onClose={closeSlash}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 12px', marginBottom: 6, background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)' }}>
          <MagnifyingGlass size={17} color="var(--color-text-secondary)" />
          <input
            value={slashQuery} onChange={(e) => setSlashQuery(e.target.value)}
            placeholder="Search slash commands…"
            autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
            style={{ flex: 1, minWidth: 0, height: '100%', background: 'none', border: 'none', outline: 'none', color: 'var(--color-text-primary)', fontSize: fontVarInput(16) }}
          />
        </div>
        {slashResults.map((c) => (
          <button key={c.cmd}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { sockRef.current?.send(c.seq); closeSlash(); }}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, width: '100%', textAlign: 'left', padding: '11px 4px', background: 'none', border: 'none', cursor: 'pointer' }}>
            <span style={{ font: `600 ${fontVar(15)} var(--font-mono)`, color: 'var(--color-accent)' }}>{c.cmd}</span>
            <span style={{ fontSize: fontVar(12.5), color: 'var(--color-text-secondary)' }}>{c.desc}</span>
          </button>
        ))}
        {slashResults.length === 0 && (
          <div style={{ padding: '20px 4px', color: 'var(--color-text-tertiary)', fontSize: fontVar(13) }}>No matching commands</div>
        )}
      </Modal>
      <DocViewer owner={terminalId} />
    </div>
  );
}
