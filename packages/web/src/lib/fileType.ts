import type { Extension } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(path);
}

/**
 * SVG is the odd one out: it IS an image (isImage includes it, and the Files pane happily
 * rasterizes it to PNG through a canvas for Copy Image) but its bytes are TEXT — so it must open
 * in the editor, not a read-only picture viewer. Callers that pick a RENDERER need `isImage(p) &&
 * !isSvg(p)`; callers that pick an image OPERATION want plain `isImage(p)`.
 */
export function isSvg(path: string): boolean {
  return /\.svg$/i.test(path);
}

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

export interface IconMeta { glyph: string; color: string }

export function fileMeta(name: string): IconMeta {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, IconMeta> = {
    ts: { glyph: 'TS', color: '#4F90D0' }, tsx: { glyph: 'TS', color: '#4F90D0' },
    js: { glyph: 'JS', color: '#E5C07B' }, jsx: { glyph: 'JS', color: '#E5C07B' }, mjs: { glyph: 'JS', color: '#E5C07B' }, cjs: { glyph: 'JS', color: '#E5C07B' },
    json: { glyph: '{}', color: '#E5C07B' },
    md: { glyph: 'M', color: '#C792EA' }, markdown: { glyph: 'M', color: '#C792EA' }, mdx: { glyph: 'M', color: '#C792EA' },
    css: { glyph: '#', color: '#56B6C2' }, scss: { glyph: '#', color: '#56B6C2' },
    html: { glyph: '<>', color: '#E06C75' }, xml: { glyph: '<>', color: '#E06C75' }, svg: { glyph: '<>', color: '#56B6C2' },
    py: { glyph: 'PY', color: '#7FBE6E' },
    sh: { glyph: '$', color: '#7FBE6E' }, bash: { glyph: '$', color: '#7FBE6E' },
    yml: { glyph: 'Y', color: '#C792EA' }, yaml: { glyph: 'Y', color: '#C792EA' },
    png: { glyph: 'IMG', color: '#56B6C2' }, jpg: { glyph: 'IMG', color: '#56B6C2' }, jpeg: { glyph: 'IMG', color: '#56B6C2' }, gif: { glyph: 'IMG', color: '#56B6C2' }, webp: { glyph: 'IMG', color: '#56B6C2' },
    lock: { glyph: 'L', color: '#5A5A61' },
  };
  return map[ext] ?? { glyph: '·', color: '#8E8E96' };
}
