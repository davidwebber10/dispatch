import { useEffect, useState } from 'react';
import { CaretDown, DotsThree, MagnifyingGlass, X } from '@phosphor-icons/react';
import { THREADS_ICON as ThreadsIcon } from '../common/viewIcons';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useEndless } from '../../stores/endless';
import { usePickerRequest } from '../../stores/pickerRequest';
import { friendlyModelName } from '../../lib/modelName';
import { HEADER_BOX, HEADER_H } from '../layout/headerButton';
import { ProviderRing } from '../layout/UsageChip';
import type { ChipRing } from '../layout/usageGauge';
import { MemorySearch } from './MemorySearch';
import { ChatAccountSheet, useAccountRing, useChatAccount } from './ChatAccount';
import { ChatMenu, type ChatMenuAt } from './ChatMenu';
import { useChatThreads } from './ChatThreads';
import { fontVar } from '../../lib/fontSize';

const WINDOW: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'Opus weekly', seven_day_sonnet: 'Sonnet weekly', seven_day_fable: 'Fable weekly', credits: 'credits' };

/** "Ultra 1, 59% of weekly used": what the ring's number is, and whose it is. */
export function ringWords(account: string | null, ring: ChipRing): string {
  const who = account ?? 'Chat account';
  const figure = ring.used === null ? 'no usage figure yet' : `${ring.used}% of ${WINDOW[ring.type ?? ''] ?? 'the limit'} used`;
  return `${who}, ${figure}${ring.paused ? ', paused on a limit' : ''}`;
}

/** A phone under 360px: the header's buttons are narrower, so the title line is not cut off. */
function useNarrow(): boolean {
  const query = '(max-width: 359px)';
  const read = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches;
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq?.addEventListener) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

/**
 * The one row at the top of Chat, in the shape of a thread's header (owner, 2026-11-27). Each thing has
 * one home: the title line says the model (and opens it) and, while a turn runs, "Working"; then search,
 * Chat's threads, the usage ring of Chat's account, and ⋯ for everything the row does not have. On the
 * phone it sits inside the app header (ChatMode portals it there); on the desktop it tops the column.
 */
export function ChatHeader({ threadsOpen, onThreads, onMemory, onProjects }: { threadsOpen: boolean; onThreads: () => void; onMemory: () => void; onProjects: () => void }) {
  const mobile = useIsMobile();
  const narrow = useNarrow();
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState<ChatMenuAt | null>(null);
  const [accounts, setAccounts] = useState(false);
  const settings = useEndless((s) => s.settings);
  const busy = useEndless((s) => s.turn.status === 'waiting' || s.turn.status === 'running');
  const account = useChatAccount();
  const model = settings?.model ?? settings?.defaultModel ?? null;
  const ring = useAccountRing(account.id, model);
  const needs = useChatThreads().needs.length;
  const width = narrow ? 32 : HEADER_H;
  const iconButton: React.CSSProperties = { ...HEADER_BOX, position: 'relative', width, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)', cursor: 'pointer' };

  if (searching) {
    return (
      <div onKeyDown={(e) => { if (e.key === 'Escape') setSearching(false); }} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <MemorySearch autoFocus onPicked={() => setSearching(false)} />
        <button type="button" aria-label="Close search" onClick={() => setSearching(false)} style={iconButton}><X size={18} /></button>
      </div>
    );
  }
  const name = friendlyModelName(model);
  // While a turn runs the line says so; the effort comes back when it ends (the row has no room for both).
  const status = (busy ? ['Working', name] : [name, settings?.effort]).filter(Boolean).join(' · ');
  const threadsName = needs ? `Threads, ${needs} need${needs === 1 ? 's' : ''} you` : 'Threads';
  const words = ringWords(account.label, ring);
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2 }}>
      <button type="button" data-testid="chat-title" aria-label={`Model and effort: ${status || 'loading'}`} title="Model and effort" disabled={!settings} onClick={() => usePickerRequest.getState().request('chat')}
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.2, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit', textAlign: 'left' }}>
        <span style={{ fontWeight: 600, fontSize: fontVar(15.5), color: 'var(--color-text-primary)' }}>Chat</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: narrow ? 3 : 5, maxWidth: '100%', font: `400 ${fontVar(narrow ? 11 : 11.5)} var(--font-mono)`, color: busy ? 'var(--color-accent)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
          {busy && <span data-testid="chat-working-dot" aria-hidden style={{ width: 7, height: 7, flexShrink: 0, borderRadius: '50%', background: 'var(--color-accent)' }} />}
          <span data-testid="chat-status" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{status}</span>
          {!(busy && narrow) && <CaretDown size={10} weight="bold" aria-hidden style={{ flexShrink: 0 }} />}
        </span>
      </button>
      <button type="button" aria-label="Search memory" title="Search memory" onClick={() => setSearching(true)} style={iconButton}><MagnifyingGlass size={20} /></button>
      <button type="button" aria-label={threadsName} title={needs ? `${needs} need${needs === 1 ? 's' : ''} you` : 'Threads that Chat started'} aria-pressed={mobile ? undefined : threadsOpen} onClick={onThreads}
        style={{ ...iconButton, ...(!mobile && threadsOpen ? { background: 'var(--color-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' } : null) }}>
        {/* The app's one Threads icon, filled while its column is open, as the tab bar and the rail fill the active one. */}
        <ThreadsIcon size={21} weight={!mobile && threadsOpen ? 'fill' : 'regular'} />
        {needs > 0 && <span data-testid="chat-threads-count" aria-hidden style={{ position: 'absolute', top: 2, right: -1, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 'var(--radius-pill)', background: 'var(--color-status-yellow)', color: 'var(--color-canvas)', font: `600 ${fontVar(10)}/15px var(--font-mono)`, textAlign: 'center' }}>{needs}</span>}
      </button>
      <button type="button" data-testid="chat-usage" aria-label={words} title={words} onClick={() => setAccounts(true)} style={{ ...iconButton, width: narrow ? 32 : 40 }}>
        <ProviderRing ring={ring} size={24} />
      </button>
      <button type="button" aria-label="Chat menu" title="Chat options and plugins" aria-expanded={!!menu}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right, y: r.bottom }); }} style={iconButton}>
        <DotsThree size={22} weight="bold" />
      </button>
      <ChatMenu at={menu} onClose={() => setMenu(null)} onAccount={() => setAccounts(true)} onMemory={onMemory} onProjects={onProjects} />
      <ChatAccountSheet open={accounts} onClose={() => setAccounts(false)} />
    </div>
  );
}
