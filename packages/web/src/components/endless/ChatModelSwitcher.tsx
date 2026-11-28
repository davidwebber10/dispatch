import { useMemo } from 'react';
import type { ChatSettings } from '../../api/types';
import { friendlyModelName, modelOptionsFor } from '../../lib/modelName';
import { EFFORT_LEVELS } from '../../lib/slash';
import { ModelChip } from '../tabs/chat/ModelSwitcher';

const NOTE = 'Saved for all of Chat. Applies from the next message.';

/**
 * Chat's model and effort card: the same card as a Pretty thread's (ModelChip), for the ONE model and effort of all of
 * Chat. It has no chip of its own (owner, 2026-11-27: the header names the model): the header's title line, the ⋯ menu
 * and the "/" menu open it. Chat starts a new process for every turn, so a change needs no waiting for a turn to end and
 * takes hold at the next one. "Default" is the model Chat runs when none is picked (`defaultModel`).
 */
export function ChatModelSwitcher({ settings, apply, reload }: {
  settings: ChatSettings;
  apply: (change: { model?: string | null; effort?: string | null }) => Promise<unknown>;
  /** Ask the daemon again; called when the card opens. */
  reload?: () => void;
}) {
  const active = settings.model ?? settings.defaultModel;
  const options = useMemo(() => modelOptionsFor('claude-code', [], active), [active]);
  return (
    <ModelChip
      owner="chat"
      label={friendlyModelName(active) ?? 'Model'}
      active={active}
      options={options}
      busy={false}
      onOpen={reload}
      alwaysSend
      cardOnly
      effortTitle="Effort for Chat"
      pickModel={async (value) => { await apply({ model: value }); return undefined; }}
      effort={{ levels: EFFORT_LEVELS['claude-code'], current: settings.effort, pick: async (level) => { await apply({ effort: level }); return NOTE; } }}
    />
  );
}
