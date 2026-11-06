// Chat's own views: the cards and rows only Chat draws. The list itself renders through the
// thread view's renderTimeline (endless/timeline.tsx wires these in as its hooks).
import { createContext, useContext, useId, useMemo, useState, type CSSProperties } from 'react';
import { useMessageScroller } from '@shadcn/react/message-scroller';
import { CaretRight, ClockCounterClockwise, Briefcase, Notebook, FileText } from '@phosphor-icons/react';
import { UserBubble } from '../tabs/chat/ChatView';
import { InsightText } from '../InsightText';
import { ChatImage } from '../ChatImage';
import { openThreadInPlace } from './openThread';
import { DocText, openDoc } from './DocText';
import { projectForPath } from '../../lib/docPaths';
import { classifyLink } from '../../lib/docLinks';
import { useEndless } from '../../stores/endless';
import { ZOOM_TOOL } from './convItems';
import type { EndlessMessage } from '../../api/types';

/**
 * Which report and note cards are open, by message, for one mounted Chat list (ChatTimeline
 * provides it). A card's row can remount while Chat stays open: renderTimeline re-keys a turn to
 * its newest item, so a new message remounts the cards above it. The state outlives that, and
 * goes with the list.
 */
export const CardOpenContext = createContext<Map<string, boolean> | null>(null);

function useCardOpen(key: string): [boolean, (f: (open: boolean) => boolean) => void] {
  const store = useContext(CardOpenContext);
  const [open, setOpen] = useState(() => store?.get(key) ?? false);
  return [open, (f) => setOpen((o) => { const next = f(o); store?.set(key, next); return next; })];
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

/** A `mcp__memory__zoom` call: one muted line naming the span it recalled. */
export function RecallLine({ tool }: { tool: EndlessMessage }) {
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
  void openThreadInPlace(m.project, m.ref);
}

const cardStyle: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'flex-start', textAlign: 'left', width: '100%', padding: '10px 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)' };
/** A button with no look of its own: the card draws it. */
const bare: React.CSSProperties = { background: 'none', border: 'none', padding: 0, margin: 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' };

/**
 * A thread report. A short one is one card that opens its thread; a long one folds to the thread
 * name and the first lines, and a tap on the header opens it. The open state is kept by message,
 * so it survives new messages.
 *
 * No control sits inside another: the card box is a plain div (a mouse click anywhere on it taps
 * it), the one real button is the header, and the text with its doc chips sits outside that button.
 * The keyboard reaches the header button, then each chip.
 */
export function WorkCard({ m }: { m: EndlessMessage }) {
  const [open, setOpen] = useCardOpen(`report:${m.i}`);
  const id = useId();
  const { scrollToMessage } = useMessageScroller();
  const head = REPORT_HEAD.exec(m.text);
  const body = head ? m.text.slice(head[0].length) : m.text;
  const short = m.text.length <= FOLD_CHARS && m.text.split('\n').length <= FOLD_LINES;
  const preview = body.split('\n').find((l) => l.trim()) ?? '';
  if (short) {
    const tap = () => openThread(m);
    return (
      <div onClick={tap} style={{ ...cardStyle, minHeight: 44, cursor: m.ref ? 'pointer' : 'default' }}>
        <button type="button" disabled={!m.ref} aria-label={head ? `Open thread ${head[1]}` : 'Open thread'} onClick={(e) => { e.stopPropagation(); tap(); }}
          style={{ ...bare, display: 'flex', flexShrink: 0, marginTop: 2, borderRadius: 'var(--radius-xs)', cursor: m.ref ? 'pointer' : 'default' }}>
          <Briefcase size={16} />
        </button>
        <span style={{ minWidth: 0, fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><DocText text={m.text} project={m.project} raised /></span>
      </div>
    );
  }
  const toggle = () => {
    // Opening grows the row. Pin its top so the scroller does not follow the new end of the content.
    if (!open) scrollToMessage(`m${m.i}`, { align: 'start' });
    setOpen((o) => !o);
  };
  return (
    <div style={{ ...cardStyle, flexDirection: 'column', gap: 0, padding: 0 }}>
      <div onClick={toggle} style={{ width: '100%', cursor: 'pointer' }}>
        <button type="button" aria-expanded={open} aria-controls={open ? id : undefined} onClick={(e) => { e.stopPropagation(); toggle(); }}
          style={{ ...bare, display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%', minHeight: open ? 44 : undefined, padding: open ? '10px 12px' : '10px 12px 2px' }}>
          <CaretRight size={13} weight="bold" style={{ flexShrink: 0, marginTop: 4, transition: 'transform .12s', transform: open ? 'rotate(90deg)' : 'none' }} />
          <Briefcase size={16} style={{ flexShrink: 0, marginTop: 2 }} />
          <span style={{ minWidth: 0, flex: 1, fontSize: 13.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{head ? head[1] : 'Thread report (continued)'}</span>
        </button>
        {/* The preview lines up under the name: 12 padding + 13 caret + 8 gap + 16 icon + 8 gap. */}
        {!open && <div style={{ padding: '0 12px 10px 57px', fontSize: 12.5, lineHeight: 1.4, color: 'var(--color-text-secondary)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' }}><DocText text={preview} project={m.project} raised /></div>}
      </div>
      {open && (
        <div id={id} style={{ padding: '0 12px 10px', minWidth: 0 }}>
          <div style={{ fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><DocText text={m.text} project={m.project} raised /></div>
          {m.ref && (
            <button type="button" onClick={() => openThread(m)} style={{ marginTop: 8, minHeight: 44, padding: '0 10px', background: 'none', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--color-text-secondary)', font: '500 12.5px var(--font-sans)' }}>Open thread</button>
          )}
        </div>
      )}
    </div>
  );
}

/** The project ids and folders as one string: a pane reload makes a new projects array, not a new key. */
const projectsKey = (s: { projects: { id: string; folder: string }[] }) => JSON.stringify(s.projects.map((p) => [p.id, p.folder]));

/** A Dispatch reply: markdown, with each doc path as a doc chip (spec 12.2). */
export function ChatProse({ m }: { m: EndlessMessage }) {
  const key = useEndless(projectsKey);
  const docs = useMemo(() => {
    const projects = (JSON.parse(key) as [string, string][]).map(([id, folder]) => ({ id, folder }));
    return {
      onOpen: (p: string, b: string | null) => openDoc(p, b, m.project),
      accept: (p: string) => projectForPath(p, m.project, projects) !== null,
      link: (href: string) => classifyLink(href, { project: m.project, projects }),
    };
  }, [m.project, key]);
  return <div style={{ fontSize: 14.5, lineHeight: 1.75, minWidth: 0 }}><InsightText source={m.text} scheme="global" variant="rail" docs={docs} /></div>;
}

/** Memories imported from a project: folded to one line, opens to the markdown. */
export function NoteCard({ m }: { m: EndlessMessage }) {
  const [open, setOpen] = useCardOpen(`note:${m.i}`);
  return (
    <div style={{ border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ ...mono, display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
        <Notebook size={13} /> Imported memories{m.projectName ? ` — ${m.projectName}` : ''}
      </button>
      {open && <div style={{ marginTop: 8, fontSize: 13.5 }}><InsightText source={m.text} scheme="global" variant="rail" /></div>}
    </div>
  );
}

/** A saved media name is `<time>-<k>-<8 hex>-<the user's name>`: the name the user gave. */
export const mediaDisplayName = (name: string) => name.replace(/^\d+-\d+-[0-9a-f]{8}-/, '');

/** A non-image attachment (a PDF, a text file): a chip that opens the saved file. */
export function FileChip({ name, href }: { name: string; href?: string }) {
  const style: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 260, height: 30, padding: '0 10px', borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-secondary)',
    fontSize: 12.5, textDecoration: 'none',
  };
  const inner = <><FileText size={15} style={{ flexShrink: 0 }} /><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span></>;
  return href ? <a href={href} target="_blank" rel="noreferrer" title={name} style={style}>{inner}</a> : <span title={name} style={style}>{inner}</span>;
}

/** The project a user message was sent to, above its bubble. */
export function ProjectLabel({ name }: { name: string }) {
  return <span style={{ alignSelf: 'flex-end', font: '500 10px var(--font-mono)', letterSpacing: '0.06em', color: 'var(--color-text-tertiary)' }}>{name}</span>;
}

/** A sent message the daemon has not logged yet, drawn like a logged one. */
export function PendingUserRow({ text, projectName, images, files = [] }: { text: string; projectName: string | null; images: { media_type: string; data: string }[]; files?: { name: string }[] }) {
  return (
    <div data-pending="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      {projectName && <ProjectLabel name={projectName} />}
      <UserBubble text={text} />
      {(images.length > 0 || files.length > 0) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {images.map((im, k) => <ChatImage key={k} src={`data:${im.media_type};base64,${im.data}`} maxHeight={220} />)}
          {files.map((f, k) => <FileChip key={`f${k}`} name={f.name} />)}
        </div>
      )}
    </div>
  );
}
