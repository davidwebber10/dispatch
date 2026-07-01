// Overseer — AgentCard: a tappable card for one of the coordinator's OWN spawn_agent /
// queue_agent / message_agent / start_agent tool calls. live.convItemsToStream pairs each
// tool_use/tool_result into an 'agentCard' StreamMessage (see types.StreamMessage's isAgentCard
// fields) instead of dropping it — this renders that inline in the stream, so a coordinator
// spawning/steering agents is no longer invisible. Tapping it opens the target agent's lightbox
// via drillInto, same action WorkRail's chips and Stream's AgencyNoticeMsg notice pills use.

import { useState } from 'react';
import { Icon, MonoLabel, StatusDot, TypeIconBox } from '../atoms';
import { Spinner } from '../../common/Spinner';
import { useOverseer, useRenderVals } from '../store';
import { AGENT_TYPE } from '../types';
import type { AgentThread, RenderVals, StreamMessage } from '../types';

const ACTION_LABEL: Record<NonNullable<StreamMessage['agentAction']>, string> = {
  spawned: 'Spawned',
  queued: 'Queued',
  messaged: 'Messaged',
  started: 'Started',
};

// message_agent/start_agent cards fall back to this when the originating spawn/queue call
// (which is where agentType comes from) isn't in the visible window.
const FALLBACK_ICON = 'ph-terminal-window';

/**
 * Find this agentId's LIVE view-model (a running thread or a queued-but-unlaunched chip)
 * across every mission, so the card mirrors WorkRail's own status dot / spinner instead of
 * inventing a second source of truth. undefined just means "nothing live to show" (e.g. the
 * agent already finished and folded into an outcome) — the card still renders, just without
 * a status indicator; read-only, no separate polling.
 */
function findLiveThread(rv: RenderVals, agentId: string): AgentThread | undefined {
  for (const mi of rv.missions) {
    const t = mi.threads.find((th) => th.key === agentId) ?? mi.queued.find((th) => th.key === agentId);
    if (t) return t;
  }
  return undefined;
}

export function AgentCard({ msg }: { msg: StreamMessage }) {
  const drillInto = useOverseer((s) => s.drillInto);
  const rv = useRenderVals();
  const [hovered, setHovered] = useState(false);
  const agentId = msg.agentId;
  if (!agentId) return null;

  const thread = findLiveThread(rv, agentId);
  const icon = msg.agentType ? AGENT_TYPE[msg.agentType].icon : FALLBACK_ICON;
  const name = msg.agentName || agentId;
  const actionLabel = ACTION_LABEL[msg.agentAction ?? 'spawned'];

  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <div
        onClick={() => drillInto(agentId)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        role="button"
        title={`Open ${name}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 12px 7px 8px',
          borderRadius: 11,
          background: hovered ? 'var(--hover)' : 'var(--elev)',
          border: `1px solid ${hovered ? '#36363c' : 'var(--border)'}`,
          cursor: 'pointer',
          maxWidth: '86%',
          transition: 'background .12s, border-color .12s',
        }}
      >
        <TypeIconBox icon={icon} size={26} />

        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--tp)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 220,
              }}
            >
              {name}
            </span>
            {/* Working → shared app spinner (parity with AgentThreadChip); any other live status
                → its dot; no live thread found (e.g. already done) → nothing, stays compact. */}
            {thread?.isWorking ? (
              <Spinner size={11} />
            ) : thread ? (
              <StatusDot color={thread.dotColor} anim={thread.dotAnim} size={5} />
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <MonoLabel size={9.5} color="var(--tt)" spacing=".06em">
              {actionLabel}
            </MonoLabel>
            {msg.agentMission && (
              <span
                style={{
                  fontSize: 10.5,
                  color: 'var(--ts)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                · {msg.agentMission}
              </span>
            )}
          </div>
        </div>

        <Icon
          name="ph-arrow-up-right"
          size={12}
          color={hovered ? 'var(--ts)' : 'var(--tt)'}
          style={{ flex: 'none', marginLeft: 2 }}
        />
      </div>
    </div>
  );
}
