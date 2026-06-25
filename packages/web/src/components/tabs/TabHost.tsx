import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { TerminalTab } from './TerminalTab';
import { BrowserTab } from './BrowserTab';
import { NotesTab } from './NotesTab';
import { FileEditorTab } from './FileEditorTab';
import { ConversationView } from './ConversationView';
import { useThreadMode } from '../../stores/threadMode';
import { useTabs } from '../../stores/tabs';
import { ModeToggle } from '../layout/ModeToggle';
import { useIsMobile } from '../../hooks/useIsMobile';

/** AI thread (claude-code/codex): View (read-only) or Terminal (interactive).
 *  The mode toggle lives in the main top bar (see ModeToggle). Defaults to
 *  Terminal so a new thread opens where you can type. */
function AiThread({ tab }: { tab: Terminal }) {
  const mode = useThreadMode((s) => s.modes[tab.id]) ?? 'expert';
  const isMobile = useIsMobile();
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      {mode === 'normal' ? <ConversationView terminalId={tab.id} /> : <TerminalTab terminalId={tab.id} />}
      {/* Desktop: the View/Terminal switcher floats over the top-right of the
          thread (mobile keeps it in the header). */}
      {!isMobile && (
        <div style={{ position: 'absolute', top: 8, right: 12, zIndex: 12 }}>
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
    case 'file': return <FileEditorTab terminal={tab} />;
    case 'shell': return <TerminalTab terminalId={tab.id} />;
    default: return <AiThread tab={tab} />;
  }
}
