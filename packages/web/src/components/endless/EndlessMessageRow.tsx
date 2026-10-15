import { useState } from 'react';
import { MessageScroller } from '@shadcn/react/message-scroller';
import { CaretRight, ClockCounterClockwise, Briefcase, Notebook, Wrench } from '@phosphor-icons/react';
import { UserBubble } from '../tabs/chat/ChatView';
import { InsightText } from '../InsightText';
import { endlessMediaUrl } from '../../api/client';
import { useUI } from '../../stores/ui';
import type { EndlessMessage } from '../../api/types';

export type Row =
  | { kind: 'msg'; m: EndlessMessage }
  | { kind: 'tool'; tool: EndlessMessage; echo?: EndlessMessage }
  | { kind: 'recall'; tool: EndlessMessage; echo?: EndlessMessage };

const ZOOM_TOOL = /^mcp__memory__zoom\s/;

/** A tool call and the result right after it fold into one row; a `zoom` call is a "recalled" row. */
export function foldRows(messages: EndlessMessage[]): Row[] {
  const rows: Row[] = [];
  for (let k = 0; k < messages.length; k++) {
    const m = messages[k];
    if (m.kind !== 'tool') { rows.push({ kind: 'msg', m }); continue; }
    const next = messages[k + 1];
    const echo = next && next.kind === 'echo' && next.i === m.i + 1 ? next : undefined;
    if (echo) k++;
    rows.push({ kind: ZOOM_TOOL.test(m.text) ? 'recall' : 'tool', tool: m, echo });
  }
  return rows;
}

/** The row key (`messageId` is `m<key>`) that shows message `i`; a folded echo maps to its tool. Null if not loaded. */
export function rowKeyOf(messages: EndlessMessage[], i: number): number | null {
  for (const r of foldRows(messages)) {
    if (r.kind === 'msg') { if (r.m.i === i) return i; continue; }
    if (r.tool.i === i || r.echo?.i === i) return r.tool.i;
  }
  return null;
}

function recallLabel(text: string): string {
  try {
    const input = JSON.parse(text.replace(ZOOM_TOOL, '')) as { id?: number; n?: number };
    return typeof input.id === 'number' && typeof input.n === 'number' ? `${input.id}+${input.n}` : '';
  } catch {
    return '';
  }
}

const mono: React.CSSProperties = { font: '400 12.5px var(--font-mono)', color: 'var(--color-text-tertiary)' };

function ToolLine({ tool, echo }: { tool?: EndlessMessage; echo?: EndlessMessage }) {
  const [open, setOpen] = useState(false);
  const head = tool?.text ?? 'result';
  const name = head.split(' ')[0];
  const rest = tool ? head.slice(name.length + 1) : '';
  return (
    <div style={{ minWidth: 0 }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        style={{ ...mono, display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
        <CaretRight size={11} weight="bold" style={{ flexShrink: 0, transition: 'transform .12s', transform: open ? 'rotate(90deg)' : 'none' }} />
        <Wrench size={13} style={{ flexShrink: 0 }} />
        <span style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }}>{name}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{rest}</span>
      </button>
      {open && (
        <pre style={{ margin: '6px 0 0 17px', padding: 10, maxHeight: 360, overflow: 'auto', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 8, font: '400 12px var(--font-mono)', color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {[tool?.text, echo?.text].filter(Boolean).join('\n\n')}
        </pre>
      )}
    </div>
  );
}

function RecallLine({ tool }: { tool: EndlessMessage }) {
  return (
    <div style={{ ...mono, display: 'flex', alignItems: 'center', gap: 6 }}>
      <ClockCounterClockwise size={12} />
      <span>{`recalled ${recallLabel(tool.text)}`.trim()}</span>
    </div>
  );
}

function WorkCard({ m }: { m: EndlessMessage }) {
  const open = () => {
    if (!m.project || !m.ref) return;
    useUI.getState().requestOpenThread({ sessionId: m.project, terminalId: m.ref });
    useUI.getState().setView('workspace');
  };
  return (
    <button type="button" onClick={open} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left', width: '100%', padding: '10px 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 8, cursor: m.ref ? 'pointer' : 'default', color: 'var(--color-text-primary)' }}>
      <Briefcase size={16} style={{ flexShrink: 0, marginTop: 2 }} />
      <span style={{ minWidth: 0, fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</span>
    </button>
  );
}

function NoteCard({ m }: { m: EndlessMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: '1px dashed var(--color-border)', borderRadius: 8, padding: '8px 12px' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ ...mono, display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
        <Notebook size={13} /> Imported memories{m.projectName ? ` — ${m.projectName}` : ''}
      </button>
      {open && <div style={{ marginTop: 8, fontSize: 13.5 }}><InsightText source={m.text} scheme="global" variant="rail" /></div>}
    </div>
  );
}

function MessageRow({ m }: { m: EndlessMessage }) {
  if (m.kind === 'user') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        {m.projectName && <span style={{ font: '500 10px var(--font-mono)', letterSpacing: '0.06em', color: 'var(--color-text-tertiary)' }}>{m.projectName}</span>}
        <UserBubble text={m.text} />
        {m.media.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {m.media.map((name) => <img key={name} src={endlessMediaUrl(name)} alt="" style={{ maxWidth: 220, maxHeight: 220, borderRadius: 8, border: '1px solid var(--color-border)' }} />)}
          </div>
        )}
      </div>
    );
  }
  if (m.kind === 'unii') return <div style={{ fontSize: 14.5, lineHeight: 1.75, minWidth: 0 }}><InsightText source={m.text} scheme="global" variant="rail" /></div>;
  if (m.kind === 'work') return <WorkCard m={m} />;
  if (m.kind === 'note') return <NoteCard m={m} />;
  return <ToolLine echo={m} />;
}

/** A sent message the daemon has not logged yet, drawn like a logged one. */
export function PendingUserRow({ text, projectName, images }: { text: string; projectName: string | null; images: { media_type: string; data: string }[] }) {
  return (
    <div data-pending="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      {projectName && <span style={{ font: '500 10px var(--font-mono)', letterSpacing: '0.06em', color: 'var(--color-text-tertiary)' }}>{projectName}</span>}
      <UserBubble text={text} />
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {images.map((im, k) => <img key={k} src={`data:${im.media_type};base64,${im.data}`} alt="" style={{ maxWidth: 220, maxHeight: 220, borderRadius: 8, border: '1px solid var(--color-border)' }} />)}
        </div>
      )}
    </div>
  );
}

export function EndlessRows({ messages, focus }: { messages: EndlessMessage[]; focus: number | null }) {
  return (
    <>
      {foldRows(messages).map((r) => {
        const key = r.kind === 'msg' ? r.m.i : r.tool.i;
        const echoI = r.kind === 'msg' ? undefined : r.echo?.i;
        return (
          <MessageScroller.Item key={key} messageId={`m${key}`} style={{ display: 'flex', flexDirection: 'column' }}>
            <div data-endless-i={key} data-endless-echo-i={echoI} style={{ borderRadius: 8, outline: focus === key || (echoI !== undefined && focus === echoI) ? '1px solid var(--color-accent)' : 'none', outlineOffset: 4 }}>
              {r.kind === 'msg' ? <MessageRow m={r.m} /> : r.kind === 'recall' ? <RecallLine tool={r.tool} /> : <ToolLine tool={r.tool} echo={r.echo} />}
            </div>
          </MessageScroller.Item>
        );
      })}
    </>
  );
}
