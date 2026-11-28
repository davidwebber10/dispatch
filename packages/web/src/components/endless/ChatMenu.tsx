import { useState } from 'react';
import { ArrowClockwise, ArrowCounterClockwise, Brain, Cpu, Folders, Stop, UserSwitch, type Icon } from '@phosphor-icons/react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useEndless } from '../../stores/endless';
import { useHint } from '../../stores/hint';
import { usePickerRequest } from '../../stores/pickerRequest';
import { usePluginRegistry, usePluginViews } from '../../plugins/registry';
import { pluginIcon } from '../../plugins/sdk';
import { PluginView } from '../../plugins/PluginView';
import { can } from '../../lib/profile';
import { friendlyModelName } from '../../lib/modelName';
import { Modal } from '../common/Modal';
import { SIZES, FlyOut, MenuRow, MenuTiles, moveFocus, rule, captionBase, type MenuTile } from '../sidebar/menuParts';
import { useAccountRing, useChatAccount } from './ChatAccount';
import { fontVar } from '../../lib/fontSize';

/** Where the desktop fly-out opens. */
export type ChatMenuAt = { x: number; y: number };

/**
 * Chat's ⋯ menu (owner, 2026-11-27): the thread menu's layout, holding only what the header row does not.
 * A plugin shows here when it has a screen of its own. A plugin row that acts on one thread (a thread menu
 * item, a right-column tab) has no place here: Chat has no thread.
 */
export function ChatMenu({ at, onClose, onAccount, onMemory, onProjects }: { at: ChatMenuAt | null; onClose: () => void; onAccount: () => void; onMemory: () => void; onProjects: () => void }) {
  const mobile = useIsMobile();
  const views = usePluginViews();
  const badges = usePluginRegistry((s) => s.badges);
  const settings = useEndless((s) => s.settings);
  const busy = useEndless((s) => s.turn.status === 'waiting' || s.turn.status === 'running');
  const account = useChatAccount();
  const model = settings?.model ?? settings?.defaultModel ?? null;
  const ring = useAccountRing(account.id, model);
  const [screen, setScreen] = useState<{ key: string; label: string } | null>(null);
  const z = SIZES[mobile ? 'sheet' : 'popover'];
  const run = (fn: () => void) => () => { onClose(); fn(); };
  const failed = (what: string) => (e: unknown) => useHint.getState().show(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  const reload = () => {
    const s = useEndless.getState();
    void Promise.all([s.loadTail(), s.refreshState(), s.loadProjects(), s.loadSettings()]).catch(failed('Could not reload Chat'));
  };

  const tiles: MenuTile[] = [
    { key: 'model', Glyph: Cpu, label: 'Model', name: 'Model and effort', value: friendlyModelName(model), disabled: !settings, onClick: run(() => usePickerRequest.getState().request('chat')) },
    { key: 'account', Glyph: UserSwitch, label: 'Account', name: 'Switch the Chat account', value: [account.label, ring.used === null ? null : `${ring.used}%`].filter(Boolean).join(' · '), onClick: run(onAccount) },
    { key: 'memory', Glyph: Brain, label: 'Memory', name: 'Memory', onClick: run(onMemory) },
  ];
  const row = (key: string, Glyph: Icon, label: string, onClick: () => void, hint?: string, trailing?: React.ReactNode) => (
    <MenuRow key={key} z={z} id={`chat-menu-hint-${key}`} Glyph={Glyph} label={label} onClick={onClick} hint={hint} trailing={trailing} />
  );
  const count = (n: number) => (n > 0 ? (
    <span aria-label={`${n} new`} style={{ marginLeft: 'auto', minWidth: 18, height: 18, padding: '0 6px', borderRadius: 'var(--radius-pill)', background: 'var(--color-accent)', color: 'var(--color-on-accent)', font: `700 ${fontVar(11)} var(--font-sans)`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{n > 99 ? '99+' : n}</span>
  ) : undefined);

  const body = (
    <>
      {row('projects', Folders, 'Projects', run(onProjects), 'Counts, documents, and threads that need you')}
      {views.length > 0 && can('settings.plugins') && (
        <div role="group" aria-label="Plugins" style={{ display: 'flex', flexDirection: 'column' }}>
          <div aria-hidden style={{ ...captionBase, ...z.caption }}>Plugins</div>
          {/* The Inbox first: it is what Chat lacked a way to. */}
          {[...views].sort((a, b) => Number(b.plugin === 'previews') - Number(a.plugin === 'previews'))
            .map((v) => row(v.key, pluginIcon(v.icon as string), v.label, run(() => setScreen({ key: v.key, label: v.label })), undefined, count(badges[v.key] ?? 0)))}
        </div>
      )}
      {rule}
      {busy
        ? row('stop', Stop, 'Stop this turn', run(() => void useEndless.getState().stop().catch(failed('Stop failed'))), 'What Chat already said stays')
        : row('retry', ArrowCounterClockwise, 'Retry last message', run(() => void useEndless.getState().retry().catch(failed('Retry failed'))), 'A new turn answers your last message')}
      {row('reload', ArrowClockwise, 'Reload Chat', run(reload), 'Load the messages and the state again')}
    </>
  );
  return (
    <>
      {mobile ? (
        <Modal open={!!at} sheet title="Chat" onClose={onClose}>
          {at && (
            // As tall as its rows, to at most the thread menu's height; then the rows scroll.
            <div role="menu" aria-label="Chat options" data-testid="chat-menu-sheet" onKeyDown={moveFocus} style={{ display: 'flex', flexDirection: 'column', maxHeight: 'calc(78dvh - 96px)', minHeight: 0 }}>
              <div style={{ flexShrink: 0 }}><MenuTiles z={z} tiles={tiles} columns={3} /></div>
              <div style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', display: 'flex', flexDirection: 'column', paddingBottom: 4 }}>{body}</div>
            </div>
          )}
        </Modal>
      ) : at && (
        <FlyOut label="Chat options" x={at.x} y={at.y} onClose={onClose}><MenuTiles z={z} tiles={tiles} columns={3} />{body}</FlyOut>
      )}
      <Modal open={!!screen} sheet title={screen?.label} onClose={() => setScreen(null)} maxWidth={860}>
        {screen && <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, height: mobile ? 'calc(100dvh - 140px - env(safe-area-inset-top) - env(safe-area-inset-bottom))' : '70vh' }}><PluginView viewKey={screen.key} /></div>}
      </Modal>
    </>
  );
}
