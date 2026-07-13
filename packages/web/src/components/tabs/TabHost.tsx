import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { TerminalTab } from './TerminalTab';
import { BrowserTab } from './BrowserTab';
import { NotesTab } from './NotesTab';
import { FileEditorTab } from './FileEditorTab';
import { ImageFileTab } from './ImageFileTab';
import { ConversationView } from './ConversationView';
import { ChatView } from './chat/ChatView';
import { useThreadMode } from '../../stores/threadMode';
import { useTabs } from '../../stores/tabs';
import { ModeToggle } from '../layout/ModeToggle';
import { useIsMobile } from '../../hooks/useIsMobile';
import { isImage, isSvg } from '../../lib/fileType';

/** True for stream-json ("structured") threads, which have no PTY and render as
 *  a chat (never a terminal). */
export function isStructured(tab: Pick<Terminal, 'config'>): boolean {
  return (tab.config as { transport?: string } | undefined)?.transport === 'structured';
}

/** AI thread (claude-code/codex). Structured (stream-json) threads have no PTY,
 *  so they render as a pure chat (ChatView) with no Terminal mode. Other AI
 *  threads keep the View (read-only) / Terminal (interactive) toggle, defaulting
 *  to Terminal so a new thread opens where you can type. */
function AiThread({ tab }: { tab: Terminal }) {
  const mode = useThreadMode((s) => s.modes[tab.id]) ?? 'expert';
  const isMobile = useIsMobile();

  // Structured threads: chat-only. No xterm (it would crash on a missing PTY),
  // no mode toggle.
  if (isStructured(tab)) return <ChatView terminalId={tab.id} />;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      {mode === 'normal' ? <ConversationView terminalId={tab.id} /> : <TerminalTab terminalId={tab.id} />}
      {/* Desktop: the View/Terminal switcher floats over the top-right of the
          thread (mobile keeps it in the header). */}
      {!isMobile && (
        <div style={{ position: 'absolute', top: 4, right: 12, zIndex: 12 }}>
          <ModeToggle terminalId={tab.id} floating />
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
