// A thin attention strip shown inside a thread (both transports) when it is waiting on the human
// with a DECLARED question that would otherwise be invisible in thread mode — see threadAsk.ts
// for the full rationale and the decision logic. Presentational: it reads the live status + the
// thread row from the stores and renders nothing unless pendingAsk() returns a question.
//
// `onAnswer` is provided by each transport so the button focuses the right input (the Pretty
// composer's textarea, or the terminal); when omitted the strip still shows the question, just
// without the shortcut. Styling uses the app-global amber status token, matching the board's
// Needs Help accent so "this needs you" reads the same in both views.

import { useThreadStatus } from '../../stores/threadStatus';
import { useTabs, findTerminal } from '../../stores/tabs';
import { pendingAsk } from './threadAsk';

export function ThreadAskBanner({ terminalId, onAnswer }: { terminalId: string; onAnswer?: () => void }) {
  const live = useThreadStatus((s) => s.byTerminal[terminalId]);
  const tab = useTabs((s) => findTerminal(s.byProject, terminalId));
  const ask = pendingAsk(live, tab);
  if (!ask) return null;

  return (
    <div
      data-testid="thread-ask-banner"
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        background: 'rgba(232,176,75,.08)',
        borderTop: '1px solid rgba(232,176,75,.35)',
        borderBottom: '1px solid rgba(232,176,75,.35)',
      }}
    >
      <span aria-hidden style={{ color: 'var(--color-status-yellow)', fontSize: 13, flexShrink: 0 }}>⏸</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-status-yellow)', fontWeight: 600 }}>
          This thread is asking you
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: 'var(--color-text-primary)',
            fontStyle: 'italic',
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 3,
            overflow: 'hidden',
          }}
        >
          {ask}
        </div>
      </div>
      {onAnswer && (
        <button
          type="button"
          onClick={onAnswer}
          style={{
            flexShrink: 0,
            background: 'transparent',
            color: 'var(--color-status-yellow)',
            border: '1px solid rgba(232,176,75,.6)',
            borderRadius: 6,
            padding: '4px 12px',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Answer
        </button>
      )}
    </div>
  );
}
