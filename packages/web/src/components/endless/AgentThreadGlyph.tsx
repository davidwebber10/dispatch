import { ChatCircle, TerminalWindow, TreeStructure } from '@phosphor-icons/react';
import { providerColor } from '../common/typeIcons';
import type { TerminalType } from '../../api/types';

/**
 * The glyph of a thread that an agent started (owner, 2026-11-27: "Option D"): the thread's own type
 * glyph, a chat bubble or a terminal, with a small tree badge on its bottom-right corner. The sizes and
 * offsets are the sidebar's (sidebar/ProjectCard.tsx ThreadRow): keep the two the same.
 */
export function AgentThreadGlyph({ harness, structured, mobile }: { harness: string; structured?: boolean; mobile: boolean }) {
  // The sidebar's rule: only a Claude chat thread is a bubble. An older daemon sends no `structured`.
  const bubble = harness === 'claude-code' && structured !== false;
  const Glyph = bubble ? ChatCircle : TerminalWindow;
  const slot = mobile ? 18 : 15;
  return (
    <span data-glyph={bubble ? 'bubble' : 'terminal'} title="Started by an agent, not by you"
      style={{ position: 'relative', width: slot, height: slot, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <Glyph size={mobile ? 17 : 14} weight="fill" color={providerColor(harness as TerminalType)} />
      <TreeStructure data-agent-badge size={mobile ? 11 : 9} weight="fill" aria-label="Started by an agent"
        style={{ position: 'absolute', right: mobile ? -6 : -5, bottom: mobile ? -5 : -4, color: 'var(--color-text-emphasis)', pointerEvents: 'none' }} />
    </span>
  );
}
