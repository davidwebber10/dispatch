import { useEffect, useState } from 'react';
import { X } from '@phosphor-icons/react';
import type { SpinnerSet, SpinnerVerbs } from '../../api/types';
import { WORD_SETS, parseWords } from '../../lib/spinnerWords';
import { SettingsRow, fieldFor, solidBtn, ghostBtn } from './ui';
import { Segmented } from '../common/Segmented';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useDispatchName } from '../../stores/settings';

type Mode = 'claude' | SpinnerVerbs['mode'];
const MODES: [Mode, string][] = [['claude', "Claude's own"], ['append', "Add to Claude's"], ['replace', 'Only mine']];

const chip = { height: 28, padding: '0 11px', background: 'transparent', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-pill)', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' } as const;

/**
 * Settings → Agents → Claude Code: the words shown while Claude works ("Flibbertigibbeting…").
 * Claude Code threads get them as their `spinnerVerbs` setting; Dispatch's own "Working…" indicator
 * (Pretty threads, Control Plane, Chat) uses the same list. Saved on blur, on a set, or on a mode change.
 * A settings row (2026-11-07): the label and hint, then the choice and the words under it.
 */
export function SpinnerWordsField({ value, onSave, sets = [], onSaveSets }: {
  value: SpinnerVerbs | undefined;
  onSave: (v: SpinnerVerbs | null) => void;
  /** Your own named sets (stored on the daemon), offered next to the built-in ones. */
  sets?: SpinnerSet[];
  onSaveSets?: (sets: SpinnerSet[] | null) => void;
}) {
  const isMobile = useIsMobile();
  const [naming, setNaming] = useState(false);
  const [setName, setSetName] = useState('');
  const saveAsSet = () => {
    const name = setName.trim();
    const words = parseWords(text);
    if (!name || !words.length || !onSaveSets) return;
    // A set with the same name is replaced, so "save" also updates one.
    const next = [...sets.filter((s) => s.name.toLowerCase() !== name.toLowerCase()), { name, words }];
    onSaveSets(next);
    setNaming(false); setSetName('');
  };
  const [mode, setMode] = useState<Mode>(value?.mode ?? 'claude');
  const [text, setText] = useState((value?.verbs ?? []).join(', '));
  useEffect(() => { setMode(value?.mode ?? 'claude'); setText((value?.verbs ?? []).join(', ')); }, [value]);

  const save = (m: Mode, t: string) => {
    const verbs = parseWords(t);
    onSave(m === 'claude' || !verbs.length ? null : { mode: m, verbs });
  };

  const words = parseWords(text).length > 0;
  const dispatchName = useDispatchName();
  return (
    <SettingsRow label="Working words" hint={`What Claude shows while it works, like “Flibbertigibbeting…”. Pretty threads, ${dispatchName} and Chat use them too.`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="spinner-words">
        <Segmented ariaLabel="Working words" value={mode}
          options={MODES.map(([m, label]) => ({ value: m, label }))}
          onChange={(v) => { const m = v as Mode; setMode(m); if (m === 'claude' || parseWords(text).length) save(m, text); }} />
        {mode !== 'claude' && (
          <>
            <textarea
              aria-label="Your working words" rows={3} value={text} placeholder="Shipping, Tinkering, On it"
              onChange={(e) => setText(e.target.value)} onBlur={() => save(mode, text)}
              style={{ ...fieldFor(isMobile), height: 'auto', minHeight: 72, padding: '8px 10px', resize: 'vertical', width: '100%', boxSizing: 'border-box', lineHeight: 1.45 }}
            />
            <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>Separate the words with commas. CLI threads get them when they start or restart.</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginRight: 2 }}>Start from</span>
              {WORD_SETS.map((s) => (
                <button key={s.name} type="button" style={chip} title={s.words.join(', ')}
                  onClick={() => { const t = s.words.join(', '); setText(t); save(mode, t); }}>{s.name}</button>
              ))}
              {sets.map((s) => (
                <span key={`mine-${s.name}`} data-testid="my-word-set" style={{ ...chip, display: 'inline-flex', alignItems: 'center', gap: 4, paddingRight: 4, color: 'var(--color-text-primary)', borderColor: 'var(--color-accent)' }}>
                  <button type="button" title={s.words.join(', ')} style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 12, cursor: 'pointer', padding: 0 }}
                    onClick={() => { const t = s.words.join(', '); setText(t); save(mode, t); }}>{s.name}</button>
                  {onSaveSets && (
                    <button type="button" aria-label={`Delete set ${s.name}`} title="Delete this set"
                      onClick={() => { const next = sets.filter((x) => x.name !== s.name); onSaveSets(next.length ? next : null); }}
                      style={{ display: 'inline-flex', background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', padding: 2 }}>
                      <X size={11} weight="bold" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {onSaveSets && (naming ? (
              <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                <input autoFocus aria-label="Set name" value={setName} maxLength={30} placeholder="Name this set"
                  onChange={(e) => setSetName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveAsSet(); if (e.key === 'Escape') setNaming(false); }}
                  style={{ ...fieldFor(isMobile), flex: 1, boxSizing: 'border-box' }} />
                <button type="button" onClick={saveAsSet} disabled={!setName.trim() || !words} style={{ ...solidBtn(!!setName.trim() && words), height: isMobile ? 36 : 30 }}>Save</button>
                <button type="button" onClick={() => setNaming(false)} style={{ ...ghostBtn, height: isMobile ? 36 : 30 }}>Cancel</button>
              </div>
            ) : (
              <button type="button" onClick={() => setNaming(true)} disabled={!words} style={{ ...ghostBtn, alignSelf: 'flex-start', opacity: words ? 1 : 0.5 }}>
                Save these words as a set
              </button>
            ))}
          </>
        )}
      </div>
    </SettingsRow>
  );
}
