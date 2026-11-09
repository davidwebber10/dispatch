// The highlight.js instance of the app, and its languages (engineering program 2026-11-09, W2-E).
//
// The first load holds the languages that most code blocks use: javascript, typescript, json, bash,
// diff, plus xml (javascript and typescript highlight JSX with it) and plaintext (the fallback).
// The other languages are one chunk (lib/highlightLanguages.ts) that loads when a code block first
// needs one of them. Until it arrives the block shows as plain text; then it is highlighted.
// Syntax colors come from the theme tokens (theme.css, "Syntax highlighting"), not a fixed highlight.js stylesheet.
import { useEffect, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import xml from 'highlight.js/lib/languages/xml';
import plaintext from 'highlight.js/lib/languages/plaintext';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('plaintext', plaintext);

hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['sh', 'zsh', 'shell', 'console'], { languageName: 'bash' });
hljs.registerAliases(['html', 'htm', 'svg', 'vue'], { languageName: 'xml' });
hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });

export { hljs };

/** In the first load. */
export const CORE_LANGUAGES: readonly string[] = ['javascript', 'typescript', 'json', 'bash', 'diff', 'xml', 'plaintext'];

/** Loaded on demand, all in one chunk. The value: the extra names a code block can use for the language. */
const LAZY: Record<string, readonly string[]> = {
  python: ['py'],
  css: [],
  yaml: ['yml'],
  markdown: ['md'],
  sql: [],
  go: ['golang'],
  rust: ['rs'],
  ini: ['toml', 'conf'],
  dockerfile: ['docker'],
};
export const LAZY_LANGUAGES: readonly string[] = Object.keys(LAZY);

/** Every name (a language or one of its aliases, lower case) that the lazy chunk brings. */
const LAZY_NAMES = new Set<string>(Object.entries(LAZY).flatMap(([name, aliases]) => [name, ...aliases]));

let lazyLoaded = false;
let lazyLoading: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

/** True when a code block in this language is highlighted now. */
export function isLanguageReady(name: string): boolean {
  return !!name && !!hljs.getLanguage(name);
}

/** True for a language that is not ready yet and that `loadLanguage` can bring. */
export function isLanguagePending(name: string | undefined): boolean {
  return !!name && !lazyLoaded && LAZY_NAMES.has(name.toLowerCase());
}

/** True once the lazy chunk is in: auto-detect then sees the same languages as before the split. */
export function allLanguagesReady(): boolean { return lazyLoaded; }

function loadLazy(): Promise<boolean> {
  if (lazyLoaded) return Promise.resolve(true);
  lazyLoading ??= import('./highlightLanguages').then(({ languages }) => {
    for (const [name, fn] of Object.entries(languages)) {
      hljs.registerLanguage(name, fn);
      if (LAZY[name]?.length) hljs.registerAliases([...LAZY[name]], { languageName: name });
    }
    lazyLoaded = true;
    for (const l of [...listeners]) l();
    return true;
  }).catch(() => { lazyLoading = null; return false; }); // a failed fetch: the block stays plain; the next call tries again
  return lazyLoading;
}

/**
 * Makes a highlight.js language ready. Resolves true when a code block in `name` is highlighted from
 * now on; false for a name that the app does not have (the block stays plain) or when the fetch failed.
 */
export function loadLanguage(name: string): Promise<boolean> {
  if (isLanguageReady(name)) return Promise.resolve(true);
  if (!isLanguagePending(name)) return Promise.resolve(false);
  return loadLazy();
}

/** Makes every language ready (auto-detect needs the full set to give the result it gave before the split). */
export function loadAllLanguages(): Promise<boolean> { return loadLazy(); }

/**
 * For a component that draws highlighted code outside <Markdown> (a tool view): asks for `lang`
 * (no `lang`: the full set, for auto-detect) and renders the component again when it is ready.
 * The result is a number that changes then; use it as a memo key.
 */
export function useHighlightLanguage(lang: string | undefined): number {
  const [version, setVersion] = useState(0);
  const wanted = lang ? isLanguagePending(lang) : !lazyLoaded;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const done = () => { if (live) setVersion((v) => v + 1); };
    listeners.add(done);
    void loadLazy();
    return () => { live = false; listeners.delete(done); };
  }, [wanted]);
  return version;
}
