import { useEffect, useState } from 'react';
import { X } from '@phosphor-icons/react';
import type { SpinnerSet, SpinnerVerbs } from '../../api/types';
import { WORD_SETS, parseWords } from '../../lib/spinnerWords';

type Mode = 'claude' | SpinnerVerbs['mode'];
const MODES: [Mode, string][] = [['claude', "Claude's own"], ['append', "Add to Claude's"], ['replace', 'Only mine']];

const seg = (on: boolean) => ({
  flex: 1, height: 30, border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12.5,
  background: on ? 'var(--color-hover)' : 'transparent', color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
} as const);
const chip = { height: 26, padding: '0 10px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-pill)', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' } as const;

/**
 * Settings → Agents → Claude Code: the words shown while Claude works ("Flibbertigibbeting…").
 * Claude Code threads get them as their `spinnerVerbs` setting; Dispatch's own "Working…" indicator
 * (Pretty threads, Control Plane, Chat) uses the same list. Saved on blur, on a set, or on a mode change.
 */
export function SpinnerWordsField({ value, onSave, sets = [], onSaveSets }: {
  value: SpinnerVerbs | undefined;
  onSave: (v: SpinnerVerbs | null) => void;
  /** Your own named sets (stored on the daemon), offered next to the built-in ones. */
  sets?: SpinnerSet[];
  onSaveSets?: (sets: SpinnerSet[] | null) => void;
}) {
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="spinner-words">
      <span style={{ fontSize: 13 }}>Working words</span>
      <div role="radiogroup" aria-label="Working words" style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
        {MODES.map(([m, label]) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} style={seg(mode === m)}
            onClick={() => { setMode(m); if (m === 'claude' || parseWords(text).length) save(m, text); }}>{label}</button>
        ))}
      </div>
      {mode !== 'claude' && (
        <>
          <textarea
            aria-label="Your working words" rows={3} value={text} placeholder="Shipping, Tinkering, On it"
            onChange={(e) => setText(e.target.value)} onBlur={() => save(mode, text)}
            style={{ resize: 'vertical', padding: '8px 10px', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', font: '400 13px var(--font-sans)' }}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>Start from:</span>
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
            <div style={{ display: 'flex', gap: 6 }}>
              <input autoFocus aria-label="Set name" value={setName} maxLength={30} placeholder="Name this set"
                onChange={(e) => setSetName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveAsSet(); if (e.key === 'Escape') setNaming(false); }}
                style={{ flex: 1, height: 30, padding: '0 10px', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 13 }} />
              <button type="button" onClick={saveAsSet} disabled={!setName.trim() || !parseWords(text).length} style={{ ...chip, height: 30 }}>Save</button>
              <button type="button" onClick={() => setNaming(false)} style={{ ...chip, height: 30 }}>Cancel</button>
            </div>
          ) : (
            <button type="button" onClick={() => setNaming(true)} disabled={!parseWords(text).length} style={{ ...chip, alignSelf: 'flex-start', opacity: parseWords(text).length ? 1 : 0.5 }}>
              Save these words as a set
            </button>
          ))}
        </>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>
        What Claude shows while it works, like “Flibbertigibbeting…”. Separate words with commas. CLI threads
        get them when they start or restart; Pretty threads, Control Plane and Chat use them for “Working…”.
      </div>
    </div>
  );
}
