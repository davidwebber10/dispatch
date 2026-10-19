import { useId, useState } from 'react';
import { MessageScroller, useMessageScroller } from '@shadcn/react/message-scroller';
import { CaretRight, ClockCounterClockwise, Briefcase, Notebook, Wrench } from '@phosphor-icons/react';
import { UserBubble } from '../tabs/chat/ChatView';
import { InsightText } from '../InsightText';
import { ChatImage } from '../ChatImage';
import { endlessMediaUrl } from '../../api/client';
import { useUI } from '../../stores/ui';
import { StartedItem } from './StartedItem';
import type { EndlessMessage } from '../../api/types';

export type Row =
  | { kind: 'msg'; m: EndlessMessage }
  | { kind: 'tool'; tool: EndlessMessage; echo?: EndlessMessage }
  | { kind: 'recall'; tool: EndlessMessage; echo?: EndlessMessage }
  | { kind: 'started'; tool: EndlessMessage; echo?: EndlessMessage };

const ZOOM_TOOL = /^mcp__memory__zoom\s/;
export const SPAWN_TOOL = /^mcp__memory__spawn_agent\s/;

export type Spawn =
  | { kind: 'starting'; name: string; projectName: string | null; task: string }
  | { kind: 'started'; agentId: string; label: string; projectName: string | null; projectId: string | null; task: string }
  | { kind: 'failed'; name: string; error: string; task: string };

/**
 * A run of N tool calls pairs with the run of up to N results right after it, in order (Claude Code
 * returns parallel results in call order). A `zoom` call is a "recalled" row; a `spawn_agent` call is
 * a Started card.
 */
export function foldRows(messages: EndlessMessage[]): Row[] {
  const rows: Row[] = [];
  let k = 0;
  while (k < messages.length) {
    const m = messages[k];
    if (m.kind !== 'tool') { rows.push({ kind: 'msg', m }); k++; continue; }
    const tools: EndlessMessage[] = [];
    while (k < messages.length && messages[k].kind === 'tool' && (tools.length === 0 || messages[k].i === tools[tools.length - 1].i + 1)) tools.push(messages[k++]);
    const echoes: EndlessMessage[] = [];
    while (k < messages.length && echoes.length < tools.length && messages[k].kind === 'echo' && messages[k].i === (echoes.length ? echoes[echoes.length - 1].i : tools[tools.length - 1].i) + 1) echoes.push(messages[k++]);
    tools.forEach((tool, n) => {
      const kind = ZOOM_TOOL.test(tool.text) ? 'recall' : SPAWN_TOOL.test(tool.text) ? 'started' : 'tool';
      rows.push({ kind, tool, echo: echoes[n] });
    });
  }
  return rows;
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';
export function parseSpawn(tool: EndlessMessage, echo?: EndlessMessage): Spawn {
  let input: { name?: unknown; project?: unknown; task?: unknown; agentType?: unknown } = {};
  try { input = JSON.parse(tool.text.replace(SPAWN_TOOL, '')); } catch { /* keep {} */ }
  const name = (typeof input.name === 'string' && input.name.trim()) || `${typeof input.agentType === 'string' ? input.agentType : 'thread'} agent`;
  const projectName = typeof input.project === 'string' ? input.project : null;
  const task = typeof input.task === 'string' ? input.task : '';
  if (!echo) return { kind: 'starting', name, projectName, task };
  try {
    const r = JSON.parse(echo.text) as { agentId?: unknown; label?: unknown; project?: unknown; projectId?: unknown };
    if (typeof r.agentId === 'string' && r.agentId) {
      return { kind: 'started', agentId: r.agentId, label: typeof r.label === 'string' ? r.label : name, projectName: typeof r.project === 'string' ? r.project : projectName, projectId: typeof r.projectId === 'string' ? r.projectId : null, task };
    }
  } catch { /* not JSON: the spawn failed */ }
  return { kind: 'failed', name, error: firstLine(echo.text), task };
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

const REPORT_HEAD = /^\[(.+?)\] report: ?/;
/** A report of at most this many characters and lines shows in full; a longer one folds. */
const FOLD_CHARS = 240;
const FOLD_LINES = 3;

function openThread(m: EndlessMessage) {
  if (!m.project || !m.ref) return;
  useUI.getState().requestOpenThread({ sessionId: m.project, terminalId: m.ref });
  useUI.getState().setView('workspace');
}

const cardStyle: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left', width: '100%', padding: '10px 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 8, color: 'var(--color-text-primary)' };

/**
 * A thread report. A short one is one card that opens its thread; a long one folds to the thread
 * name and the first lines, and a tap on the header opens it. The open state is local to the row,
 * so it survives new messages (the row keeps its key).
 */
function WorkCard({ m }: { m: EndlessMessage }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { scrollToMessage } = useMessageScroller();
  const head = REPORT_HEAD.exec(m.text);
  const body = head ? m.text.slice(head[0].length) : m.text;
  const short = m.text.length <= FOLD_CHARS && m.text.split('\n').length <= FOLD_LINES;
  if (short) {
    return (
      <button type="button" onClick={() => openThread(m)} style={{ ...cardStyle, cursor: m.ref ? 'pointer' : 'default' }}>
        <Briefcase size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span style={{ minWidth: 0, fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</span>
      </button>
    );
  }
  const preview = body.split('\n').find((l) => l.trim()) ?? '';
  return (
    <div style={{ ...cardStyle, flexDirection: 'column', gap: 0, padding: 0 }}>
      <button type="button" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => {
          // Opening grows the row. Pin its top so the scroller does not follow the new end of the content.
          if (!open) scrollToMessage(`m${m.i}`, { align: 'start' });
          setOpen((o) => !o);
        }}
        style={{ display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%', minHeight: 44, padding: '10px 12px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'inherit', font: 'inherit' }}>
        <CaretRight size={13} weight="bold" style={{ flexShrink: 0, marginTop: 4, transition: 'transform .12s', transform: open ? 'rotate(90deg)' : 'none' }} />
        <Briefcase size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{head ? head[1] : 'Thread report (continued)'}</span>
          {!open && <span style={{ fontSize: 12.5, lineHeight: 1.4, color: 'var(--color-text-secondary)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }}>{preview}</span>}
        </span>
      </button>
      {open && (
        <div id={id} style={{ padding: '0 12px 10px', minWidth: 0 }}>
          <div style={{ fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
          {m.ref && (
            <button type="button" onClick={() => openThread(m)} style={{ marginTop: 8, minHeight: 44, padding: '0 10px', background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, cursor: 'pointer', color: 'var(--color-text-secondary)', font: '500 12.5px var(--font-sans)' }}>Open thread</button>
          )}
        </div>
      )}
    </div>
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
            {m.media.map((name) => <ChatImage key={name} src={endlessMediaUrl(name)} maxHeight={220} />)}
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
          {images.map((im, k) => <ChatImage key={k} src={`data:${im.media_type};base64,${im.data}`} maxHeight={220} />)}
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
              {r.kind === 'msg' ? <MessageRow m={r.m} /> : r.kind === 'recall' ? <RecallLine tool={r.tool} /> : r.kind === 'started' ? <StartedItem tool={r.tool} echo={r.echo} /> : <ToolLine tool={r.tool} echo={r.echo} />}
            </div>
          </MessageScroller.Item>
        );
      })}
    </>
  );
}
