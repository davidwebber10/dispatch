// Overseer — the pinned decision card (pinned card spec 2026-10-08, Unit 7).
//
// The project's decision ledger as a live card, drawn from the daemon's data (GET …/ledger/card,
// kept by stores/ledgerCard.ts). The user sees every open item with its full context here, so the
// overseer's recap can shrink to news. Desktop: the top of the right pane's Details tab
// (DispatchWorkPane), above "Ongoing work". Mobile: the top of the Work tab (OverseerMobile).
//
//   • Header — "Needs you", the counts, the time of the last update; a folded "Project rules"
//     line that opens the read-only list.
//   • Needs you now — full cards (the new ones, then the top 5), one line for the rest; a click
//     on a line opens it as a full card.
//   • Your tests and actions, Running on defaults, Decided since the last recap, Not yet
//     triaged, Parked — each folds to a count; the fold state is kept in local storage.
//
// A click never sends anything: an option, the Approve row of a go item and the Done link of an
// action hand their answer text ("N17: A", "N34: approve", "N55: done") to `onAnswer`, which adds
// it to the message box; the user presses Enter.

import { useState, type CSSProperties, type ReactNode } from 'react';
import { MonoLabel } from '../atoms';
import { useProjects } from '../../../stores/projects';
import { useLedgerCard, useLedgerCardEntry, useLedgerFolds, type LedgerFold } from '../../../stores/ledgerCard';
import { timeAgo } from '../../../lib/time';
import { answerText, formatCardSource, formatUpdated, openDecisionCount, outcomeText } from '../ledger';
import type { CardItem, CardOption, LedgerCard as Card } from '../../../api/types';

const KIND: Record<CardItem['kind'], string> = { go: 'Go', decide: 'Decide', do: 'Do', statement: 'Statement' };
/** About three lines of the pane's width: a longer context is cut, with "more". */
const CONTEXT_CLAMP_CHARS = 180;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isImported = (item: CardItem) => item.origin === 'imported' && item.quote === null;

const smallButton: CSSProperties = {
  background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', fontSize: 11.5, color: 'var(--acc)', cursor: 'pointer',
};

function Badge({ children, color = 'var(--acc)' }: { children: ReactNode; color?: string }) {
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', color, border: `1px solid ${color}`, borderRadius: 4, padding: '0 4px', lineHeight: 1.5 }}>
      {children}
    </span>
  );
}

/** A labelled paragraph of a full card: "Why A. 5 nights:", "If you do not answer:", "Holds up:", … */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--ts)' }}>
      <span style={{ fontWeight: 600, color: 'var(--tp)' }}>{label}</span> <span>{children}</span>
    </div>
  );
}

/** One option as a stacked row: the label, then its effect. A click adds the answer; only an open item takes one. */
function OptionRow({ item, option, onAnswer }: { item: CardItem; option: CardOption; onAnswer?: (text: string) => void }) {
  const recommended = option.label === item.recommendation;
  const live = item.status === 'open';
  const style: CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 2, width: '100%', textAlign: 'left', fontFamily: 'inherit',
    padding: '6px 9px', borderRadius: 7, cursor: live ? 'pointer' : 'default',
    background: recommended ? 'var(--accDim)' : 'var(--pane)',
    border: `1px solid ${recommended ? 'var(--accLine)' : 'var(--border)'}`,
  };
  const body = (
    <>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tp)' }}>{option.label}</span>
        {recommended && <span style={{ fontSize: 10.5, color: 'var(--acc)' }}>Recommended</span>}
      </span>
      {option.effect && <span style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--ts)' }}>{option.effect}</span>}
    </>
  );
  if (!live) return <div data-recommended={recommended} style={style}>{body}</div>;
  const text = answerText(item, option);
  return (
    <button type="button" data-recommended={recommended} title={`Add "${text}" to the message box`} onClick={() => onAnswer?.(text)} style={style}>
      {body}
    </button>
  );
}

/** The full card: the number and kind, the question, the context, the options, why, the default, … */
function FullCard({ item, onAnswer, onFold }: { item: CardItem; onAnswer?: (text: string) => void; onFold?: () => void }) {
  const [more, setMore] = useState(false);
  const long = (item.context?.length ?? 0) > CONTEXT_CLAMP_CHARS;
  const clamped = long && !more;
  const age = item.status === 'open' && item.sentAt ? `open ${timeAgo(item.sentAt)}` : null;
  const outcome = item.status === 'open' ? null : outcomeText(item);
  return (
    <article
      data-ledger-seq={item.seq}
      data-full="true"
      style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '10px 12px', borderRadius: 9, background: 'var(--elev)', border: '1px solid var(--border)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--ts)' }}>
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--tp)' }}>N{item.seq}</span>
        <span>{KIND[item.kind]}</span>
        {item.isNew && <Badge>NEW</Badge>}
        {age && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--tt)' }}>{age}</span>}
        {isImported(item) && <span style={{ color: 'var(--tt)' }}>imported</span>}
        <span style={{ flex: 1 }} />
        {onFold && <button type="button" onClick={onFold} style={{ ...smallButton, color: 'var(--tt)' }}>fold</button>}
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.45, color: 'var(--tp)' }}>{item.text}</div>
      {item.original && <Field label={`Original question (N${item.original.seq}):`}>"{item.original.text}"</Field>}
      {item.context && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
          <div
            data-testid="ledger-context"
            data-clamped={clamped}
            style={{
              fontSize: 12.5, lineHeight: 1.5, color: 'var(--ts)',
              ...(clamped ? { display: '-webkit-box', WebkitBoxOrient: 'vertical' as const, WebkitLineClamp: 3, overflow: 'hidden' } : {}),
            }}
          >
            {item.context}
          </div>
          {long && <button type="button" onClick={() => setMore(!more)} style={smallButton}>{more ? 'less' : 'more'}</button>}
        </div>
      )}
      {item.options.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {item.options.map((o) => <OptionRow key={o.label} item={item} option={o} onAnswer={onAnswer} />)}
        </div>
      )}
      {item.kind === 'go' && item.status === 'open' && (
        <button
          type="button"
          title={`Add "${answerText(item)}" to the message box`}
          onClick={() => onAnswer?.(answerText(item))}
          style={{ textAlign: 'left', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, color: 'var(--tp)', padding: '6px 9px', borderRadius: 7, background: 'var(--accDim)', border: '1px solid var(--accLine)', cursor: 'pointer' }}
        >
          Approve
        </button>
      )}
      {item.why && <Field label={item.recommendation ? `Why ${item.recommendation}:` : 'Why:'}>{item.why}</Field>}
      {!item.why && item.recommendation && <Field label="Recommended:">{item.recommendation}</Field>}
      {item.default && <Field label="If you do not answer:">{item.default}</Field>}
      {item.blocks && <Field label="Holds up:">{item.blocks}</Field>}
      {item.source && <Field label="Source:">{formatCardSource(item.source)}</Field>}
      {item.overseerNote && <Field label="Overseer's note:">{item.overseerNote}</Field>}
      {outcome && <Field label="Outcome:">{outcome}</Field>}
    </article>
  );
}

/** One line: the number and the question, plus a short detail; a click opens it as a full card. */
function ItemLine({ item, detail, onOpen, action }: { item: CardItem; detail?: string | null; onOpen: () => void; action?: ReactNode }) {
  return (
    <div data-ledger-seq={item.seq} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <button
        type="button"
        onClick={onOpen}
        style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 7px', textAlign: 'left', fontFamily: 'inherit', background: 'none', border: 'none', padding: '3px 0', cursor: 'pointer' }}
      >
        <span style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--tp)' }}>{`N${item.seq} · ${item.text}`}</span>
        {item.isNew && <Badge>NEW</Badge>}
        {isImported(item) && <span style={{ fontSize: 11, color: 'var(--tt)' }}>imported</span>}
        {detail && <span style={{ fontSize: 11.5, color: 'var(--ts)' }}>{detail}</span>}
      </button>
      {action}
    </div>
  );
}

/** A section below "Needs you now": folded to its count by default; open, one line per item. */
function FoldSection({ fold, title, items, children }: { fold: LedgerFold; title: string; items: CardItem[]; children: (item: CardItem) => ReactNode }) {
  const open = useLedgerFolds((s) => !!s.open[fold]);
  const setOpen = useLedgerFolds((s) => s.setOpen);
  if (!items.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(fold, !open)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit', background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', color: 'var(--ts)', fontSize: 12 }}
      >
        <span aria-hidden style={{ fontSize: 9, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
        <span style={{ fontWeight: 600 }}>{title}</span>{' '}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--tt)' }}>{items.length}</span>
      </button>
      {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 15 }}>{items.map(children)}</div>}
    </div>
  );
}

function RulesLine({ card }: { card: Card }) {
  const open = useLedgerFolds((s) => !!s.open.rules);
  const setOpen = useLedgerFolds((s) => s.setOpen);
  if (!card.sections.rulesCount) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen('rules', !open)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--ts)', fontSize: 11.5 }}
      >
        <span aria-hidden style={{ fontSize: 9, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
        Project rules: {card.sections.rulesCount} in force
      </button>
      {open && (
        <ul style={{ margin: 0, paddingLeft: 30, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: 'var(--ts)' }}>
          {card.rules.map((r) => (
            <li key={r.seq}>{`N${r.seq} · "${r.quote}"${r.reading ? ` — I read this as: ${r.reading}` : ''}`}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LedgerCard({ onAnswer }: { onAnswer?: (text: string) => void } = {}) {
  const projectId = useProjects((s) => s.activeId);
  const { card, error } = useLedgerCardEntry(projectId);
  // Lines and section rows the user opened as full cards.
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (seq: number) => setOpened((cur) => {
    const next = new Set(cur);
    if (!next.delete(seq)) next.add(seq);
    return next;
  });
  if (!projectId) return null;

  // An item the user opened draws as a full card in place of its line.
  const line = (item: CardItem, detail?: string | null, action?: ReactNode) =>
    opened.has(item.seq)
      ? <FullCard key={item.seq} item={item} onAnswer={onAnswer} onFold={() => toggle(item.seq)} />
      : <ItemLine key={item.seq} item={item} detail={detail} onOpen={() => toggle(item.seq)} action={action} />;

  const decisions = openDecisionCount(card);
  const s = card?.sections;
  return (
    <section
      data-testid="ledger-card"
      aria-label="Needs you"
      style={{ flex: '0 1 auto', maxHeight: '60%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: '13px 16px', borderBottom: '1px solid var(--border)' }}
    >
      <div data-testid="ledger-card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <MonoLabel color="var(--yellow)">Needs you</MonoLabel>
        {s && <span style={{ fontSize: 12, color: 'var(--ts)' }}>{plural(decisions, 'decision')} · {plural(s.actions.length, 'action')}</span>}
        <span style={{ flex: 1 }} />
        {card?.updatedAt && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--tt)' }}>updated {formatUpdated(card.updatedAt)}</span>}
      </div>

      {error && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--red)' }}>
          <span>Could not load the decisions</span>
          <button type="button" onClick={() => void useLedgerCard.getState().load(projectId)} style={smallButton}>Retry</button>
        </div>
      )}
      {!card && !error && <div style={{ fontSize: 12, color: 'var(--tt)' }}>Loading the decisions…</div>}

      {card && s && (
        <>
          <RulesLine card={card} />
          {decisions === 0 && s.actions.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--ts)' }}>Nothing needs you.</div>}
          {s.needsYou.cards.map((item) => <FullCard key={item.seq} item={item} onAnswer={onAnswer} />)}
          {s.needsYou.lines.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {s.needsYou.lines.map((item) => line(item, item.recommendation ? `Rec: ${item.recommendation}` : null))}
            </div>
          )}
          <FoldSection fold="actions" title="Your tests and actions" items={s.actions}>
            {(item) => line(item, null, item.status === 'open' && (
              <button type="button" title={`Add "${answerText(item)}" to the message box`} onClick={() => onAnswer?.(answerText(item))} style={smallButton}>Done</button>
            ))}
          </FoldSection>
          <FoldSection fold="onDefaults" title="Running on defaults" items={s.onDefaults}>
            {(item) => line(item, outcomeText(item))}
          </FoldSection>
          <FoldSection fold="decidedSince" title="Decided since the last recap" items={s.decidedSince}>
            {(item) => line(item, outcomeText(item))}
          </FoldSection>
          <FoldSection fold="untriaged" title="Not yet triaged" items={s.untriaged}>
            {(item) => line(item, `from "${item.author}"`)}
          </FoldSection>
          <FoldSection fold="parked" title="Parked" items={s.parked}>
            {(item) => line(item, outcomeText(item))}
          </FoldSection>
        </>
      )}
    </section>
  );
}
