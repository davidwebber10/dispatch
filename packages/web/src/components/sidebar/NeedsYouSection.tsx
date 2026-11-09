import { CaretDown, CaretRight, HourglassMedium } from '@phosphor-icons/react';
import { useAttention, type AttentionItem } from '../../lib/attention';
import { useProjects } from '../../stores/projects';
import { useSectionCollapse, collapseKey } from '../../stores/sectionCollapse';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMinuteTick } from '../../lib/autoArchive';
import { timeAgo } from '../../lib/time';
import { StatusDot } from '../common/StatusDot';

/** The fold of this section in the section-collapse store: one for all projects. */
const SCOPE = '*';
const SECTION = 'needs-you';

const REASON: Record<AttentionItem['reason'], string> = { needs_input: 'Needs input', error: 'Error', stalled: 'No output' };

/** "Needs input · 12m", "Error · 3h", "No output for 14 min". */
function reasonText(item: AttentionItem, now: number): string {
  if (item.reason === 'stalled') return `No output for ${Math.max(1, Math.floor((now - item.since) / 60_000))} min`;
  const ago = item.since ? timeAgo(new Date(item.since).toISOString(), now) : '';
  return ago ? `${REASON[item.reason]} · ${ago}` : REASON[item.reason];
}

/**
 * "Needs you (N)": the attention queue as one list above the projects, across all projects
 * (engineering program 2026-11-09, W2-F). Needs input first, then errors, then stalled threads; in a
 * group the thread that has waited longest is first. A row opens its thread and does nothing else:
 * there is no Answer button and no pop-up, and nothing is drawn inside a thread
 * (lib/noAskStrip.test.ts). The section is absent when nothing waits, and it folds.
 *
 * Its own component on purpose (W1-F): the queue changes on every status event, and only this list
 * renders for it, not the sidebar and its project cards.
 */
export function NeedsYouSection({ onOpen }: { onOpen: (projectId: string, terminalId: string) => void }) {
  const items = useAttention();
  const sessions = useProjects((s) => s.sessions);
  const collapsed = useSectionCollapse((s) => s.collapsed[collapseKey(SCOPE, SECTION)] === true);
  const isMobile = useIsMobile();
  const now = useMinuteTick(items.length > 0 && !collapsed);
  if (!items.length) return null;
  const nameOf = new Map(sessions.map((s) => [s.id, s.name]));
  const Caret = collapsed ? CaretRight : CaretDown;
  return (
    <section aria-label="Needs you" data-testid="needs-you" style={{ margin: isMobile ? '6px 8px 4px' : '0 0 8px', border: '1px solid color-mix(in srgb, var(--color-status-yellow) 35%, var(--color-border))', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', overflow: 'hidden' }}>
      <button type="button" aria-expanded={!collapsed} onClick={() => useSectionCollapse.getState().toggle(SCOPE, SECTION)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: isMobile ? '11px 12px' : '7px 9px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', font: `700 ${isMobile ? 13 : 11}px var(--font-mono)`, letterSpacing: '0.6px', color: 'var(--color-text-secondary)' }}>
        <span style={{ flex: 1 }}>Needs you ({items.length})</span>
        <Caret aria-hidden size={isMobile ? 13 : 11} weight="bold" style={{ flexShrink: 0, color: 'var(--color-text-tertiary)' }} />
      </button>
      {!collapsed && (
        <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 3px' }}>
          {items.map((item) => (
            <li key={item.terminalId} data-attention-id={item.terminalId} data-reason={item.reason}>
              <button type="button" className="needs-you-row" title={`Open “${item.label}”`} onClick={() => onOpen(item.projectId, item.terminalId)}
                style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: isMobile ? '10px 12px' : '5px 9px', background: 'transparent', border: 'none', borderTop: '1px solid var(--color-border)', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ width: 14, flexShrink: 0, display: 'inline-flex', justifyContent: 'center', color: 'var(--color-text-tertiary)' }}>
                  {item.reason === 'stalled' ? <HourglassMedium aria-hidden size={isMobile ? 15 : 13} /> : <StatusDot state={item.reason} size={isMobile ? 10 : 8} />}
                </span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ fontSize: isMobile ? 15 : 12.5, fontWeight: 500, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                  <span style={{ fontSize: isMobile ? 12.5 : 11, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {[nameOf.get(item.projectId), reasonText(item, now)].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
