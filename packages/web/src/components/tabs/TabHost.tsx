import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { TerminalTab } from './TerminalTab';
import { BrowserTab } from './BrowserTab';
import { NotesTab } from './NotesTab';
import { FileEditorTab } from './FileEditorTab';
import { ImageFileTab } from './ImageFileTab';
import { ChatView } from './chat/ChatView';
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
function AiThread({ tab }: { tab: Terminal }) {
  const isMobile = useIsMobile();
  const structured = isStructured(tab);

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      {/* Structured threads are chat-only (no xterm — it would crash on a missing PTY);
          CLI threads render the terminal. */}
      {structured ? <ChatView terminalId={tab.id} /> : <TerminalTab terminalId={tab.id} />}
      {/* Desktop: the CLI⇄Pretty transport switch floats over the top-right (the only render
          switch now; mobile keeps the same control in its header). */}
      {!isMobile && (
        <div style={{ position: 'absolute', top: 4, right: 12, zIndex: 12, display: 'flex', gap: 6 }}>
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
