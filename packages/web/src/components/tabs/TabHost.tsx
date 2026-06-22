import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { TerminalTab } from './TerminalTab';
import { BrowserTab } from './BrowserTab';
import { NotesTab } from './NotesTab';
import { FileEditorTab } from './FileEditorTab';
import { ConversationView } from './ConversationView';
import { useThreadMode, type ThreadMode } from '../../stores/threadMode';

/** AI thread (claude-code/codex): a Normal (conversation) / Expert (terminal) toggle. */
function AiThread({ tab }: { tab: Terminal }) {
  const defaultMode: ThreadMode = tab.type === 'codex' ? 'expert' : 'normal';
  const mode = useThreadMode((s) => s.modes[tab.id]) ?? defaultMode;
  const setMode = useThreadMode((s) => s.set);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
        <div style={{ display: 'flex', background: 'var(--color-elevated)', border: '1px solid #2c2c32', borderRadius: 8, padding: 2, gap: 2 }}>
          {([['normal', 'Normal'], ['expert', 'Expert']] as const).map(([m, label]) => (
            <button key={m} onClick={() => setMode(tab.id, m)} style={{
              padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12,
              fontWeight: mode === m ? 600 : 500,
              background: mode === m ? 'var(--color-hover)' : 'transparent',
              color: mode === m ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
            }}>{label}</button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {mode === 'normal' ? <ConversationView terminalId={tab.id} /> : <TerminalTab terminalId={tab.id} />}
      </div>
    </div>
  );
}

/** Renders the active tab by its backend type. */
export function TabHost({ terminalId }: { terminalId: string }) {
  const [tab, setTab] = useState<Terminal | null>(null);

  useEffect(() => {
    let on = true;
    setTab(null);
    void api.getTerminal(terminalId).then((t) => { if (on) setTab(t); });
    return () => { on = false; };
  }, [terminalId]);

  if (!tab) return <div style={{ padding: 12, color: 'var(--color-text-secondary)' }}>Loading…</div>;
  switch (tab.type) {
    case 'browser': return <BrowserTab terminal={tab} />;
    case 'notes': return <NotesTab terminal={tab} />;
    case 'file': return <FileEditorTab terminal={tab} />;
    case 'shell': return <TerminalTab terminalId={tab.id} />;
    default: return <AiThread tab={tab} />;
  }
}
