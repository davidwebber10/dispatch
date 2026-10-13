import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { TerminalTab } from './TerminalTab';
import { BrowserTab } from './BrowserTab';
import { NotesTab } from './NotesTab';
import { FileEditorTab } from './FileEditorTab';
import { ImageFileTab } from './ImageFileTab';
import { ChatView } from './chat/ChatView';
import { CliPrettyHint } from './CliPrettyHint';
import { CliStatusCard } from './CliStatusCard';
import { useTabs } from '../../stores/tabs';
import { TransportToggle } from '../layout/TransportToggle';
import { AlertBell } from '../layout/AlertBell';
import { useIsMobile } from '../../hooks/useIsMobile';
import { isImage, isSvg } from '../../lib/fileType';

/** True for stream-json ("structured") threads, which have no PTY and render as
 *  a chat (never a terminal). */
export function isStructured(tab: Pick<Terminal, 'config'>): boolean {
  return (tab.config as { transport?: string } | undefined)?.transport === 'structured';
}

/** AI thread (claude-code/codex). Structured (stream-json) threads render as a pure chat
 *  (ChatView); CLI threads render the real terminal. The old frontend-only "View" render of
 *  a PTY thread (ConversationView, behind a View/Terminal toggle) was removed — switch the
 *  thread to Pretty (real stream-json) via the TransportToggle for a rendered chat. */
// The floating controls' right offset, and the gap the Pretty hint keeps from them.
const FLOATING_RIGHT = 12;
const FLOATING_GAP = 8;

function AiThread({ tab }: { tab: Terminal }) {
  const isMobile = useIsMobile();
  const structured = isStructured(tab);
  // On desktop the bell and the CLI/Pretty switch float over the top-right corner, which is the
  // right end of the Pretty hint: they hid its "Switch to Pretty" and dismiss buttons (2026-10-12).
  // Measure the floating group, so the hint keeps that space free whatever the switch shows.
  const floatingRef = useRef<HTMLDivElement>(null);
  const [floatingWidth, setFloatingWidth] = useState(0);
  useLayoutEffect(() => {
    const el = floatingRef.current;
    if (!el) { setFloatingWidth(0); return; }
    const measure = () => setFloatingWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile, structured]);
  const hintReserve = !isMobile && floatingWidth > 0 ? Math.ceil(floatingWidth) + FLOATING_RIGHT + FLOATING_GAP : undefined;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      {/* Structured threads are chat-only (no xterm — it would crash on a missing PTY);
          CLI threads render the terminal, topped by a one-time nudge toward Pretty, with the
          latest declared turn outcome UNDER it, in its footer (the TUI collapses
          report_status's arguments, so a turn's substance was otherwise invisible here; at the
          bottom, as in a Pretty thread). Keyed by thread so a tab switch never carries one
          thread's outcome state onto another. */}
      {structured ? <ChatView terminalId={tab.id} /> : (
        <>
          <CliPrettyHint tab={tab} reserveRight={hintReserve} />
          <TerminalTab terminalId={tab.id} footer={<CliStatusCard key={tab.id} tab={tab} />} />
        </>
      )}
      {/* Desktop: the CLI⇄Pretty transport switch floats over the top-right (the only render
          switch now; mobile keeps the same control in its header). */}
      {!isMobile && (
        <div ref={floatingRef} data-testid="thread-floating-controls" style={{ position: 'absolute', top: 4, right: FLOATING_RIGHT, zIndex: 12, display: 'flex', gap: 6 }}>
          <AlertBell terminalId={tab.id} floating />
          <TransportToggle terminalId={tab.id} floating />
        </div>
      )}
    </div>
  );
}

/** Renders the active tab by its backend type. */
export function TabHost({ terminalId }: { terminalId: string }) {
  // Render instantly from the tab the sidebar already loaded; only hit the network
  // when it isn't cached (avoids a "Loading…" flash on every thread switch).
  const cached = useTabs((s) => {
    for (const list of Object.values(s.byProject)) { const t = list.find((x) => x.id === terminalId); if (t) return t; }
    return null;
  });
  const [tab, setTab] = useState<Terminal | null>(cached);

  useEffect(() => {
    if (cached) { setTab(cached); return; }
    let on = true;
    setTab(null);
    void api.getTerminal(terminalId).then((t) => { if (on) setTab(t); });
    return () => { on = false; };
  }, [terminalId, cached]);

  if (!tab) return <div style={{ padding: 12, color: 'var(--color-text-secondary)' }}>Loading…</div>;
  switch (tab.type) {
    case 'browser': return <BrowserTab terminal={tab} />;
    case 'notes': return <NotesTab terminal={tab} />;
    case 'file': {
      // Binary images can't go through the CodeMirror editor — /files/read is utf-8 JSON and
      // would hand back mojibake. SVG is the exception: it is TEXT (the mojibake rationale does
      // not apply, and languageFor() maps it to the html() mode), so it keeps opening in the
      // editor where it can actually be read and edited.
      const p = (tab.config?.path as string) || tab.label;
      return isImage(p) && !isSvg(p) ? <ImageFileTab terminal={tab} /> : <FileEditorTab terminal={tab} />;
    }
    case 'shell': return <TerminalTab terminalId={tab.id} />;
    default: return <AiThread tab={tab} />;
  }
}
