import { useEffect, useState } from 'react';
import { ArrowSquareOut, FileCode, Package, Terminal, type Icon as PhosphorIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { ToolStatus, ToolsResponse } from '../../api/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import { timeAgo } from '../../lib/time';
import { ghostBtn, codeChip, fieldFor, SettingsPage, SettingsGroup, SettingsRow, StatusMark, EmptyState, type Tone } from './ui';

type Bucket = 'needs-auth' | 'unchecked' | 'ready' | 'missing';
const bucketOf = (t: ToolStatus): Bucket => {
  if (!t.installed) return 'missing';
  const state = t.authState ?? (t.authed ? 'ok' : 'needed'); // older daemons send only `authed`
  return state === 'ok' ? 'ready' : state === 'unknown' ? 'unchecked' : 'needs-auth';
};
/** The list order: what needs a look first. */
const ORDER: Bucket[] = ['needs-auth', 'unchecked', 'ready', 'missing'];
const STATUS: Record<Bucket, { label: string; tone: Tone }> = {
  'needs-auth': { label: 'Sign in needed', tone: 'yellow' },
  unchecked: { label: "Couldn't check", tone: 'muted' },
  ready: { label: 'Installed', tone: 'accent' },
  missing: { label: 'Missing', tone: 'muted' },
};
/** The row's icon says how the tool is installed (it replaces the old BINARY / NPM / SCRIPT chip). */
const KIND_ICON: Record<ToolStatus['kind'], PhosphorIcon> = { binary: Terminal, npm: Package, script: FileCode };
/** A filter row shows only when the list is long enough to need one. */
const FILTER_AT = 9;

// When the daemon last ran each CLI's sign-in check (it caches the answer for a few minutes).
function checkedLabel(iso: string | null): string {
  if (!iso) return 'Not checked yet';
  const ago = timeAgo(iso);
  return ago === 'now' ? 'Checked just now' : `Checked ${ago} ago`;
}

/** The docs link: a quiet icon on the row, so the list stays one line per tool. */
function DocsLink({ name, href }: { name: string; href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" aria-label={`${name} docs`} title="Open the docs"
      style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-tertiary)' }}>
      <ArrowSquareOut size={15} />
    </a>
  );
}

/**
 * Settings → Tools (redesigned 2026-11-07, docs/design/settings-layout.md): one group, a row per
 * CLI (kind icon, name, one-line description, a status mark, a quiet docs link). Tools that need a
 * look sort first. "Check again" re-runs the daemon's sign-in checks.
 */
export function ToolsSection() {
  const isMobile = useIsMobile();
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const apply = (r: ToolsResponse) => { setTools(r.tools); setCheckedAt(r.checkedAt); setErr(''); };
  useEffect(() => { (async () => {
    try { apply(await api.getTools()); } catch { setErr('Could not reach Dispatch.'); }
    setLoaded(true);
  })(); }, []);
  const checkAgain = async () => {
    setChecking(true);
    try { apply(await api.getTools({ refresh: true })); } catch { setErr('Could not reach Dispatch.'); }
    finally { setChecking(false); }
  };

  const q = query.trim().toLowerCase();
  const matched = q ? tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) : tools;
  const sorted = ORDER.flatMap((b) => matched.filter((t) => bucketOf(t) === b));
  const needsAuth = tools.filter((t) => bucketOf(t) === 'needs-auth').length;

  const checkBtn = (
    <button style={{ ...ghostBtn, ...(checking ? { opacity: 0.6, cursor: 'default' } : {}) }} disabled={checking} onClick={() => void checkAgain()}>
      {checking ? 'Checking…' : 'Check again'}
    </button>
  );
  const footer = (
    <>
      {needsAuth > 0 && <div style={{ color: 'var(--color-text-secondary)' }}>{needsAuth} tool{needsAuth === 1 ? ' needs' : 's need'} a sign-in. Run its login command once in a terminal.</div>}
      <span title={checkedAt ? new Date(checkedAt).toLocaleString() : undefined}>{checkedLabel(checkedAt)}</span> · Tools run with your shell environment.
    </>
  );

  return (
    <SettingsPage intro={<>Command-line tools that every agent thread can run. Add your own in <code style={codeChip}>~/.dispatch/tools.json</code>, then run <code style={codeChip}>dispatch tools install</code>.</>}>
      {!loaded ? null : tools.length === 0 ? (
        <EmptyState action={checkBtn}>No tools found. Check again, or add your own in tools.json.</EmptyState>
      ) : (
        <SettingsGroup title="Tools" action={checkBtn} footer={footer}>
          {tools.length >= FILTER_AT && (
            <div key="filter" style={{ padding: '8px 12px' }}>
              <input aria-label="Filter tools" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter tools"
                style={{ ...fieldFor(isMobile), width: '100%' }} />
            </div>
          )}
          {sorted.map((t) => {
            const b = bucketOf(t);
            return (
              <div key={t.name} data-testid="tool-row" data-tool={t.name}>
                <SettingsRow icon={KIND_ICON[t.kind] ?? Terminal} label={t.name} hint={t.description}
                  control={<>
                    <StatusMark tone={STATUS[b].tone}>{STATUS[b].label}</StatusMark>
                    {t.docs && <DocsLink name={t.name} href={t.docs} />}
                  </>} />
              </div>
            );
          })}
          {q && sorted.length === 0 && (
            <div key="none" style={{ padding: '14px 12px', fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>No tools match “{query}”.</div>
          )}
        </SettingsGroup>
      )}
      {err && <div style={{ color: 'var(--color-status-red)', fontSize: 12, padding: '0 4px' }}>{err}</div>}
    </SettingsPage>
  );
}
