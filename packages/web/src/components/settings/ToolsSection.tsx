import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ToolStatus } from '../../api/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import { pageLabel, summaryLine, miniChip, codeChip, GroupHeader, HoverRow, SearchInput, FilterSegments } from './ui';

const desc: React.CSSProperties = { fontSize: 12.5, color: 'var(--color-text-secondary)' };
const colHead: React.CSSProperties = { font: '600 9.5px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
const grid = 'minmax(230px,1.2fr) 130px 160px minmax(120px,0.5fr)';

type Bucket = 'needs-auth' | 'ready' | 'missing';
const bucketOf = (t: ToolStatus): Bucket => (!t.installed ? 'missing' : t.authed ? 'ready' : 'needs-auth');

function StatusCell({ bucket }: { bucket: Bucket }) {
  const [dot, text, label] = bucket === 'ready'
    ? ['var(--color-accent)', 'var(--color-text-secondary)', 'installed · authed']
    : bucket === 'needs-auth'
      ? ['var(--color-status-red)', 'var(--color-status-red)', 'needs auth']
      : ['#4a4a52', 'var(--color-text-tertiary)', 'not installed'];
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot }} />
      <span style={{ font: '400 11px var(--font-mono)', color: text, whiteSpace: 'nowrap' }}>{label}</span>
    </span>
  );
}

export function ToolsSection() {
  const isMobile = useIsMobile();
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [seg, setSeg] = useState<'all' | 'ready' | 'needs-auth'>('all');
  useEffect(() => { (async () => {
    try { setTools((await api.getTools()).tools); } catch { setErr('Could not reach Dispatch.'); }
  })(); }, []);

  const matched = query ? tools.filter((t) => t.name.toLowerCase().includes(query.toLowerCase()) || t.description.toLowerCase().includes(query.toLowerCase())) : tools;
  const ready = matched.filter((t) => bucketOf(t) === 'ready');
  const needsAuth = matched.filter((t) => bucketOf(t) === 'needs-auth');
  const missing = matched.filter((t) => bucketOf(t) === 'missing');
  const needsAuthTotal = tools.filter((t) => bucketOf(t) === 'needs-auth').length;

  const renderRow = (t: ToolStatus) => (isMobile ? (
    <HoverRow key={t.name} style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '9px 2px' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <span style={{ font: '500 12px var(--font-mono)', color: '#e9e9ec', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
        <span style={miniChip}>{t.kind}</span>
        <span style={{ flex: 1 }} />
        <StatusCell bucket={bucketOf(t)} />
      </span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</span>
        {t.docs && <a href={t.docs} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: 'var(--color-accent)', flexShrink: 0 }}>docs</a>}
      </span>
    </HoverRow>
  ) : (
    <HoverRow key={t.name} style={{ display: 'grid', gridTemplateColumns: grid, gap: 8, alignItems: 'center', padding: '8px 2px' }}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ font: '500 12px var(--font-mono)', color: '#e9e9ec', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
        <span style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</span>
      </span>
      <span><span style={miniChip}>{t.kind}</span></span>
      <StatusCell bucket={bucketOf(t)} />
      <span style={{ textAlign: 'right' }}>
        {t.docs && <a href={t.docs} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: 'var(--color-accent)' }}>docs</a>}
      </span>
    </HoverRow>
  ));

  const groups: { key: Bucket; label: string; tone: 'accent' | 'red' | 'neutral'; hint: string; items: ToolStatus[] }[] = [
    { key: 'needs-auth', label: 'NEEDS AUTH', tone: 'red', hint: 'Installed, but the agent cannot use them yet', items: needsAuth },
    { key: 'ready', label: 'READY', tone: 'accent', hint: 'Available in every thread', items: ready },
    { key: 'missing', label: 'MISSING', tone: 'neutral', hint: 'Not found on PATH', items: missing },
  ];
  const visible = groups.filter((g) => g.items.length > 0 && (seg === 'all' || seg === g.key));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={pageLabel}>TOOLS (CLI)</span>
      <div style={desc}>
        CLIs bundled with Dispatch and available to the agent in every thread. Add your own in <code style={codeChip}>~/.dispatch/tools.json</code>, then run <code style={codeChip}>dispatch tools install</code>.
      </div>
      {err && <div style={{ color: 'var(--color-status-red)', fontSize: 12 }}>{err}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SearchInput value={query} onChange={setQuery} placeholder="Filter tools" />
        {!isMobile && (
          <>
            <FilterSegments active={seg} onSelect={(k) => setSeg(k as typeof seg)}
              options={[
                { key: 'all', label: 'All', count: tools.length },
                { key: 'ready', label: 'Ready', count: tools.filter((t) => bucketOf(t) === 'ready').length },
                { key: 'needs-auth', label: 'Needs auth', count: needsAuthTotal },
              ]} />
            <span style={{ ...summaryLine, flexShrink: 0 }}>{tools.length} tool{tools.length === 1 ? '' : 's'} · {needsAuthTotal} need auth</span>
          </>
        )}
      </div>

      {!isMobile && visible.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: grid, gap: 8, alignItems: 'center', padding: '4px 2px', borderBottom: '1px solid var(--color-hover)' }}>
          <span style={colHead}>TOOL</span>
          <span style={colHead}>KIND</span>
          <span style={colHead}>STATUS</span>
          <span />
        </div>
      )}
      {visible.map((g) => (
        <div key={g.key} style={{ display: 'flex', flexDirection: 'column' }}>
          <GroupHeader label={g.label} count={g.items.length} tone={g.tone} hint={isMobile ? undefined : g.hint} />
          {g.items.map(renderRow)}
        </div>
      ))}
      {tools.length > 0 && matched.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', textAlign: 'center', padding: '14px 0' }}>No tools match “{query}”</div>}

      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', borderTop: '1px solid var(--color-hover)', paddingTop: 8, marginTop: 2 }}>Tools run with your shell environment.</div>
    </div>
  );
}
