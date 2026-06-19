import { useEffect, useState } from 'react';
import type { Session, Terminal } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { StatusDot } from '../common/StatusDot';
import { providerVisual } from '../common/typeIcons';
import { timeAgo } from '../../lib/time';
import { NewTabMenu } from './NewTabMenu';
import { api } from '../../api/client';

function dotState(status: string): 'working' | 'idle' | 'needs_input' {
  if (status === 'working') return 'working';
  if (status === 'needs_input') return 'needs_input';
  return 'idle';
}

const SECTIONS: { key: string; label: string; types: Terminal['type'][]; add: 'menu' | 'browser' | 'notes' | null }[] = [
  { key: 'threads', label: 'THREADS', types: ['claude-code', 'codex', 'shell'], add: 'menu' },
  { key: 'web', label: 'WEB', types: ['browser'], add: 'browser' },
  { key: 'notes', label: 'NOTES', types: ['notes'], add: 'notes' },
  { key: 'files', label: 'FILES', types: ['file'], add: null },
];

const plusBtn: React.CSSProperties = { width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', font: '600 14px/1 var(--font-sans)', borderRadius: 4 };

function homePath(p: string): string {
  return (p || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function ThreadRow({ tab, active, onClick, onMiddle }: { tab: Terminal; active: boolean; onClick: (e: React.MouseEvent) => void; onMiddle: () => void }) {
  const [hover, setHover] = useState(false);
  const { Icon: PIcon, color } = providerVisual(tab.type);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onMiddle(); } }}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 9px',
        background: active ? 'var(--color-hover)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        borderRadius: 6, border: 'none',
        color: active ? '#fff' : 'var(--color-text-primary)', fontSize: 12.5, fontWeight: active ? 500 : 400,
        textAlign: 'left', cursor: 'pointer',
      }}
    >
      <PIcon size={15} weight="fill" color={color} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.label}</span>
      <StatusDot state={dotState(tab.status)} size={7} />
    </button>
  );
}

export function ProjectCard({ session, active, onSelectTab }: { session: Session; active: boolean; onSelectTab: (id: string) => void }) {
  const tabs = useTabs((s) => s.byProject[session.id]) ?? [];
  const activeTabId = useTabs((s) => s.activeTabId);
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => { if (active) void useTabs.getState().loadTabs(session.id); }, [active, session.id]);

  async function addTab(type: string, config?: Record<string, unknown>) {
    const t = await api.createTerminal(session.id, { type, ...(config ? { config } : {}) });
    await useTabs.getState().loadTabs(session.id);
    onSelectTab(t.id);
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: active ? 'rgba(62,207,106,0.10)' : hover ? 'rgba(255,255,255,0.04)' : 'transparent',
        border: active ? '1px solid rgba(62,207,106,0.45)' : '1px solid transparent',
        borderRadius: 8, padding: 4, marginBottom: 4, cursor: 'pointer', transition: 'background 0.12s ease, border-color 0.12s ease',
      }}
    >
      <div style={{ padding: '5px 6px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 14.5, color: active ? '#fff' : 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{session.name}</span>
          <span title={session.lastActivityAt ?? ''} style={{ marginLeft: 'auto', flexShrink: 0, font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{timeAgo(session.lastActivityAt)}</span>
        </div>
        <div title={session.workingDir} style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{homePath(session.workingDir)}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateRows: active ? '1fr' : '0fr', transition: 'grid-template-rows 0.2s ease' }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          {SECTIONS.map((sec) => {
            const items = tabs.filter((t) => sec.types.includes(t.type));
            if (sec.key !== 'threads' && !items.length) return null;
            return (
              <div key={sec.key} style={{ marginTop: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 6px' }}>
                  <span style={{ font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', flex: 1 }}>{sec.label}</span>
                  {sec.add && (
                    <span style={{ position: 'relative', display: 'inline-flex' }}>
                      <button title={`Add ${sec.label.toLowerCase()}`} onClick={(e) => {
                        e.stopPropagation();
                        if (sec.add === 'menu') setMenu((o) => !o);
                        else if (sec.add === 'browser') void addTab('browser', { url: 'about:blank' });
                        else if (sec.add === 'notes') void addTab('notes');
                      }} style={plusBtn}>+</button>
                      {sec.add === 'menu' && menu && <NewTabMenu sessionId={session.id} onClose={() => setMenu(false)} onCreated={onSelectTab} />}
                    </span>
                  )}
                </div>
                {items.map((t) => (
                  <ThreadRow key={t.id} tab={t} active={t.id === activeTabId} onClick={(e) => { e.stopPropagation(); onSelectTab(t.id); }} onMiddle={() => useTabs.getState().openTab(t.id, true)} />
                ))}
                {sec.key === 'threads' && !items.length && <div style={{ padding: '2px 6px', fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No threads yet</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
