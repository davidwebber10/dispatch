// Overseer — the Control Plane's hooks into the thread view's renderTimeline
// (components/tabs/chat/ChatView.tsx). The coordinator transcript is the same ConvItem[]
// a thread renders; these are the only places the Control Plane draws it differently:
//
//   toolCard   — spawn/queue/message/start_agent calls become tappable AgentCards
//                (live.agencyCards pairs each call with its result over the whole window).
//   hideResult — a standalone agency result whose call fell outside the window is internal
//                agentId bookkeeping, not output: dropped (live.isOrphanAgencyResult).
//   userRow    — the daemon's agency notices and 💬 direct-message notices arrive on the user
//                role; they draw as a pill / card instead of a "You" bubble (AgencyNotices.tsx).
//   prose / plainText — ledger numbers draw as chips in assistant prose, the user's bubbles
//                and report_status cards (LedgerChips.tsx).

import type { ConvItem } from '../../api/types';
import type { LedgerChips } from '../../lib/ledgerRefs';
import { AssistantText, type TimelineExtensions } from '../tabs/chat/ChatView';
import { agencyCards, isOrphanAgencyResult } from './live';
import { AgentCard } from './components/AgentCard';
import { AgencyNoticeMsg, DirectMessageNoticeMsg, detectAgencyNotice, detectDirectMessageNotice } from './components/AgencyNotices';
import { LedgerChipText } from './components/LedgerChips';

/** The Control Plane's renderTimeline extensions for this transcript window. Build once per
 *  (items, ledger) — the agent-card pre-pass walks the whole window. */
export function controlPlaneTimeline(items: ConvItem[], ledger?: LedgerChips): TimelineExtensions {
  const cards = agencyCards(items);
  return {
    toolCard: (tool) => {
      if (!tool.toolId || !cards.has(tool.toolId)) return undefined;
      const card = cards.get(tool.toolId);
      return card ? <AgentCard card={card} /> : null;
    },
    hideResult: isOrphanAgencyResult,
    userRow: (item) => {
      const text = item.text ?? '';
      const dm = detectDirectMessageNotice(text);
      if (dm) return <DirectMessageNoticeMsg notice={dm} ledger={ledger} />;
      const notice = detectAgencyNotice(text);
      if (notice) return <AgencyNoticeMsg notice={notice} ledger={ledger} />;
      return undefined;
    },
    prose: (text) => <AssistantText text={text} ledger={ledger} />,
    plainText: (text) => <LedgerChipText text={text} ledger={ledger} />,
  };
}
