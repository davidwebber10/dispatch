import { useEffect, useState } from 'react';
import { Brain, PushPin, Trash, ChatCircleText, Note } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { MemoryPage, MemoryNote, MemoryVersion, MemorySearchHit, MemoryTurnHit } from '../../api/types';
import { useMemory, projectOfScope } from '../../stores/memory';
import { useUI } from '../../stores/ui';
import { Markdown } from '../Markdown';
import { ConfirmModal } from '../common/ConfirmModal';
import {
  SettingsGroup, SettingsRow, SettingsSubPage, SettingsDisclosure, EmptyState, SearchInput, FilterSegments, Toggle,
  fieldInput, ghostBtn, solidBtn, dangerBtn, noteText,
} from '../settings/ui';
import { fontVar } from '../../lib/fontSize';

/**
 * One scope of memory (spec 2026-11-17-memory-design.md, part 5): what threads see, search (memory or
 * past conversations), the pages and the new notes, and one page with its editor and history. The
 * desktop Memory view and the phone's Settings → Memory both show it.
 */

const mono: React.CSSProperties = { font: `400 ${fontVar(11.5)}/1.55 var(--font-mono)`, color: 'var(--color-text-secondary)' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The daemon marks matches with \u0002 … \u0003 (db/memory.ts). */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/g);
  return <>{parts.map((p, k) => (p.startsWith('\u0002') ? <mark key={k}>{p.slice(1, -1)}</mark> : <span key={k}>{p}</span>))}</>;
}

const ORIGIN: Record<string, string> = { thread: 'a thread', user: 'you', analyzer: 'Dispatch', import: 'an import' };
const noteSource = (n: MemoryNote) => `${ORIGIN[n.origin] ?? n.origin}${n.harness ? ` (${n.harness})` : ''} · ${when(n.createdAt)}`;

export function MemoryScopePanel() {
  const scope = useMemory((s) => s.scope);
  const scopes = useMemory((s) => s.scopes);
  const pages = useMemory((s) => s.pages);
  const notes = useMemory((s) => s.notes);
  const block = useMemory((s) => s.block);
  const settings = useMemory((s) => s.settings);
  const [openId, setOpenId] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const info = scopes?.find((s) => s.scope === scope);
  const projectId = projectOfScope(scope);
  useEffect(() => { setOpenId(null); setErr(''); }, [scope]);

  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); await useMemory.getState().loadScope(); } catch (e) { setErr(message(e)); } };
  const errLine = err && <div role="alert" style={{ fontSize: fontVar(12.5), color: 'var(--color-status-red)' }}>{err}</div>;

  if (openId !== null) return <PageView id={openId} onBack={() => setOpenId(null)} />;

  const remembered = info?.remembered !== false;
  return (
    <div data-testid="memory-scope-panel" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {projectId && settings && (
        <SettingsGroup>
          <SettingsRow label="Remember this project" hint={remembered ? 'Threads of this project read and save its memory.' : 'Threads of this project use only "You". Nothing new is kept for it.'}
            control={<Toggle on={remembered} label="Remember this project" onClick={() => {
              const off = new Set(settings.projectsOff);
              if (remembered) off.add(projectId); else off.delete(projectId);
              void useMemory.getState().updateSettings({ projectsOff: [...off] });
            }} />} />
        </SettingsGroup>
      )}
      {errLine}
      <Search scope={scope} projectId={projectId} onOpenPage={setOpenId} />
      {block && (
        <SettingsDisclosure label={`What threads see (${block.chars.toLocaleString()} of ${block.cap.toLocaleString()} characters)`}
          hint={projectId ? 'The exact text a new thread of this project gets.' : 'The exact text a new thread gets (in a project, its project follows).'} testId="memory-block">
          <pre data-testid="memory-block-text" style={{ ...mono, margin: 0, padding: '11px 12px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto' }}>
            {block.text || 'Memory is off: threads get no block.'}
          </pre>
        </SettingsDisclosure>
      )}
      <PagesGroup scope={scope} pages={pages} onOpen={setOpenId} run={run} />
      <SettingsGroup title={`New notes${notes ? ` (${notes.length})` : ''}`} footer="Notes that threads or you saved. Every thread can find a note at once; new threads see the newest ones.">
        {notes && notes.length === 0 && <div style={{ ...noteText, padding: '11px 12px' }}>No new notes.</div>}
        {notes?.map((n) => (
          <SettingsRow key={n.id} icon={Note} label={n.text} ariaLabel={`Note ${n.id}`}
            hint={<>{noteSource(n)}{n.aboutSlug ? ` · about ${n.aboutSlug}` : ''}</>}
            control={<button type="button" aria-label={`Delete note ${n.id}`} style={dangerBtn} onClick={() => void run(() => api.memoryDeleteNote(n.id))}>Delete</button>} />
        ))}
        <AddNote scope={scope} run={run} />
      </SettingsGroup>
    </div>
  );
}

function AddNote({ scope, run }: { scope: string; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [text, setText] = useState('');
  const save = () => { const t = text.trim(); if (!t) return; void run(async () => { await api.memoryAddNote({ scope, text: t }); setText(''); }); };
  return (
    <div style={{ display: 'flex', gap: 8, padding: '9px 12px' }}>
      <input aria-label="New note" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note…"
        onKeyDown={(e) => { if (e.key === 'Enter') save(); }} style={{ ...fieldInput, flex: 1 }} />
      <button type="button" style={solidBtn(!!text.trim())} disabled={!text.trim()} onClick={save}>Save</button>
    </div>
  );
}

function PagesGroup({ scope, pages, onOpen, run }: { scope: string; pages: ReturnType<typeof useMemory.getState>['pages']; onOpen: (id: number) => void; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const create = () => void run(async () => {
    const p = await api.memoryCreatePage({ scope, slug: slug.trim(), description: description.trim() });
    setAdding(false); setSlug(''); setDescription('');
    onOpen(p.id);
  });
  return (
    <SettingsGroup title={`Pages${pages ? ` (${pages.length})` : ''}`}
      action={<button type="button" style={ghostBtn} onClick={() => setAdding((v) => !v)}>{adding ? 'Cancel' : '+ New page'}</button>}>
      {adding && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '9px 12px' }}>
          <input aria-label="Page slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="slug, e.g. deploy-rules" style={{ ...fieldInput, flex: '1 1 160px' }} />
          <input aria-label="Page description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line: what it is about" style={{ ...fieldInput, flex: '2 1 220px' }} />
          <button type="button" style={solidBtn(!!slug.trim())} disabled={!slug.trim()} onClick={create}>Create</button>
        </div>
      )}
      {pages && pages.length === 0 && !adding && <div style={{ ...noteText, padding: '11px 12px' }}>No pages yet.</div>}
      {pages?.map((p) => (
        <SettingsRow key={p.id} icon={p.pinned ? PushPin : Brain} label={p.slug} ariaLabel={`${p.slug}: open`}
          hint={<span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.description || '(no description)'}</span>}
          onClick={() => onOpen(p.id)} />
      ))}
    </SettingsGroup>
  );
}

function Search({ scope, projectId, onOpenPage }: { scope: string; projectId: string | null; onOpenPage: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [where, setWhere] = useState<'memory' | 'conversations'>('memory');
  const [hits, setHits] = useState<MemorySearchHit[] | MemoryTurnHit[] | null>(null);
  useEffect(() => {
    const query = q.trim();
    if (!query) { setHits(null); return; }
    let live = true;
    const t = setTimeout(() => {
      const p = where === 'memory' ? api.memorySearch(query, scope) : api.memorySearchConversations(query, projectId);
      p.then((r) => { if (live) setHits(r.results); }).catch(() => { if (live) setHits([]); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, where, scope, projectId]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <SearchInput value={q} onChange={setQ} placeholder={where === 'memory' ? 'Search memory…' : 'Search past conversations…'} style={{ flex: '1 1 220px' }} />
        <FilterSegments options={[{ key: 'memory', label: 'Memory' }, { key: 'conversations', label: 'Conversations' }]} active={where} onSelect={(k) => setWhere(k as 'memory' | 'conversations')} />
      </div>
      {hits && (
        <SettingsGroup title={hits.length ? 'Results' : undefined}>
          {hits.length === 0 && <div style={{ ...noteText, padding: '11px 12px' }}>No matches.</div>}
          {where === 'memory'
            ? (hits as MemorySearchHit[]).map((h) => (
              <SettingsRow key={`${h.kind}-${h.id}`} icon={h.kind === 'page' ? Brain : Note} label={h.kind === 'page' ? (h.slug ?? '') : `Note${h.slug ? ` about ${h.slug}` : ''}`}
                hint={<Snippet text={h.snippet} />} onClick={h.kind === 'page' ? () => onOpenPage(h.id) : undefined} />
            ))
            : (hits as MemoryTurnHit[]).map((h) => (
              <SettingsRow key={h.id} icon={ChatCircleText} label={`${h.thread} · ${h.role === 'user' ? 'you' : 'agent'}`} ariaLabel={`Open thread ${h.thread}`}
                hint={<><span style={{ display: 'block' }}>{when(h.at)}</span><Snippet text={h.snippet} /></>}
                onClick={() => useUI.getState().requestOpenThread({ sessionId: h.sessionId, terminalId: h.terminalId })} />
            ))}
        </SettingsGroup>
      )}
    </div>
  );
}

const ACTOR: Record<string, string> = { user: 'you', dream: 'a dream', import: 'an import' };

/** One page: the text, edit (with the sha the editor started from), pin, delete, newer notes, history. */
function PageView({ id, onBack }: { id: number; onBack: () => void }) {
  const [page, setPage] = useState<MemoryPage | null>(null);
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [versions, setVersions] = useState<MemoryVersion[] | null>(null);
  const [shown, setShown] = useState<MemoryVersion | null>(null);
  const [editing, setEditing] = useState<{ description: string; body: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState('');
  const load = async () => {
    try { const r = await api.memoryPage(id); setPage(r.page); setNotes(r.notes); } catch (e) { setErr(message(e)); }
    if (versions) setVersions((await api.memoryVersions(id).catch(() => ({ versions: [] }))).versions);
  };
  useEffect(() => { void load(); }, [id]);
  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    try { await fn(); await load(); void useMemory.getState().loadScope(); } catch (e) { setErr(message(e)); }
  };
  if (!page) return <div style={noteText}>{err || 'Loading…'}</div>;
  const save = () => editing && void act(async () => {
    await api.memoryUpdatePage(page.id, { ...editing, expectedSha: page.sha });
    setEditing(null);
  });
  return (
    <SettingsSubPage testId={`memory-page-${page.slug}`} icon={Brain} title={page.slug} description={page.description || undefined}
      subtitle={`Changed by ${ACTOR[page.updatedBy] ?? page.updatedBy}, ${when(page.updatedAt)} · last checked ${page.verifiedAt ? when(page.verifiedAt) : 'never'} · read ${page.readCount} times`}
      backLabel="Memory" onBack={onBack}>
      {err && <div role="alert" style={{ fontSize: fontVar(12.5), color: 'var(--color-status-red)' }}>{err}</div>}
      {editing ? (
        <SettingsGroup title="Edit">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '9px 12px' }}>
            <input aria-label="Description" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} style={fieldInput} />
            <textarea aria-label="Page text" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={16}
              style={{ ...fieldInput, height: 'auto', padding: 9, font: `${fontVar(12.5)}/1.55 var(--font-mono)`, resize: 'vertical' }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={ghostBtn} onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" style={solidBtn(true)} onClick={save}>Save</button>
            </div>
          </div>
        </SettingsGroup>
      ) : (
        <SettingsGroup action={<button type="button" style={ghostBtn} onClick={() => setEditing({ description: page.description, body: page.body })}>Edit</button>}>
          <div data-testid="memory-page-body" style={{ padding: '11px 12px', minHeight: 40 }}>
            {page.body ? <Markdown source={page.body} /> : <span style={noteText}>Empty page.</span>}
          </div>
        </SettingsGroup>
      )}
      {notes.length > 0 && (
        <SettingsGroup title="Newer notes about this page" footer="A dream merges them into the page later. Until then, threads that read the page see them under it.">
          {notes.map((n) => <SettingsRow key={n.id} icon={Note} label={n.text} hint={noteSource(n)} />)}
        </SettingsGroup>
      )}
      <SettingsGroup>
        <SettingsRow label="Pin" hint="A pinned page is named first in “Where to start”." control={<Toggle on={page.pinned} label="Pin" onClick={() => void act(() => api.memoryUpdatePage(page.id, { pinned: !page.pinned }))} />} />
        <SettingsRow label="Delete page" ariaLabel="Delete page" danger onClick={() => setConfirm(true)} />
      </SettingsGroup>
      <SettingsDisclosure label="History" hint="Every version. Restore puts one back as the newest version." testId="memory-history">
        <HistoryLoader id={page.id} versions={versions} setVersions={setVersions} />
        {versions?.map((v) => (
          <SettingsRow key={v.id} label={`${v.op} by ${ACTOR[v.actor] ?? v.actor}`} hint={when(v.at)}
            control={<span style={{ display: 'flex', gap: 6 }}>
              <button type="button" style={ghostBtn} onClick={() => setShown(shown?.id === v.id ? null : v)}>{shown?.id === v.id ? 'Hide' : 'View'}</button>
              <button type="button" style={ghostBtn} aria-label={`Restore version ${v.id}`} onClick={() => void act(() => api.memoryRestore(page.id, v.id))}>Restore</button>
            </span>} />
        ))}
        {shown && <pre style={{ ...mono, margin: 0, padding: '11px 12px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{shown.body || '(empty)'}</pre>}
      </SettingsDisclosure>
      <ConfirmModal open={confirm} danger title={`Delete ${page.slug}?`} confirmLabel="Delete page"
        message="Threads stop seeing it. Its history stays, and a restore brings it back."
        onCancel={() => setConfirm(false)} onConfirm={() => {
          setConfirm(false);
          api.memoryDeletePage(page.id).then(() => { void useMemory.getState().loadScope(); onBack(); }).catch((e) => setErr(message(e)));
        }} />
    </SettingsSubPage>
  );
}

/** Loads the history the first time the disclosure is drawn. */
function HistoryLoader({ id, versions, setVersions }: { id: number; versions: MemoryVersion[] | null; setVersions: (v: MemoryVersion[]) => void }) {
  useEffect(() => { if (!versions) void api.memoryVersions(id).then((r) => setVersions(r.versions)).catch(() => setVersions([])); }, [id, versions]);
  return versions ? null : <EmptyState>Loading…</EmptyState>;
}

/** Memory on, and Pause: the switches that apply to every scope. */
export function MemorySwitches() {
  const settings = useMemory((s) => s.settings);
  if (!settings) return null;
  return (
    <SettingsGroup>
      <SettingsRow label="Memory" hint={settings.enabled ? 'Threads get the block and the memory tools.' : 'Off: threads get no block and no memory tools.'}
        control={<Toggle on={settings.enabled} label="Memory" onClick={() => void useMemory.getState().updateSettings({ enabled: !settings.enabled })} />} />
      <SettingsRow label="Pause" hint="Threads still read memory. Nothing new is saved."
        control={<Toggle on={settings.paused} label="Pause" onClick={() => void useMemory.getState().updateSettings({ paused: !settings.paused })} />} />
    </SettingsGroup>
  );
}
