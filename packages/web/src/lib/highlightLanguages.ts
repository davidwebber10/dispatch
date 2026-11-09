// The highlight.js languages that are not in the first load (engineering program 2026-11-09, W2-E).
// lib/highlight.ts imports this file on demand, as one chunk: one request brings all of them, so a
// second language on a slow link costs no second round trip.
import type { LanguageFn } from 'highlight.js';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';

export const languages: Record<string, LanguageFn> = { python, css, yaml, markdown, sql, go, rust, ini, dockerfile };
