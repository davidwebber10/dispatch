// CodeMirror language modes by file name. Kept apart from fileType.ts so the file-icon and
// image checks the whole app uses don't pull CodeMirror into the startup script.
import type { Extension } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { isMarkdown } from './fileType';

export function languageFor(path: string): Extension[] {
  const p = path.toLowerCase();
  if (/\.tsx$/.test(p)) return [javascript({ typescript: true, jsx: true })];
  if (/\.ts$/.test(p)) return [javascript({ typescript: true })];
  if (/\.jsx$/.test(p)) return [javascript({ jsx: true })];
  if (/\.(js|mjs|cjs)$/.test(p)) return [javascript()];
  if (/\.json$/.test(p)) return [json()];
  if (isMarkdown(p)) return [markdown()];
  if (/\.(html?|xml|svg|vue)$/.test(p)) return [html()];
  if (/\.(css|scss|less)$/.test(p)) return [css()];
  if (/\.py$/.test(p)) return [python()];
  if (/\.ya?ml$/.test(p)) return [yaml()];
  return [];
}
