
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

/**
 * Tabular text we can offer a grid for. `.tsv` rides along free — the parser detects the
 * delimiter, so the only difference is the default.
 */
export function isCsv(path: string): boolean {
  return /\.(csv|tsv)$/i.test(path);
}

export interface IconMeta { glyph: string; color: string }

export function fileMeta(name: string): IconMeta {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, IconMeta> = {
    ts: { glyph: 'TS', color: 'var(--color-blue)' }, tsx: { glyph: 'TS', color: 'var(--color-blue)' },
    js: { glyph: 'JS', color: 'var(--color-yellow)' }, jsx: { glyph: 'JS', color: 'var(--color-yellow)' }, mjs: { glyph: 'JS', color: 'var(--color-yellow)' }, cjs: { glyph: 'JS', color: 'var(--color-yellow)' },
    json: { glyph: '{}', color: 'var(--color-yellow)' },
    md: { glyph: 'M', color: 'var(--color-purple)' }, markdown: { glyph: 'M', color: 'var(--color-purple)' }, mdx: { glyph: 'M', color: 'var(--color-purple)' },
    css: { glyph: '#', color: 'var(--color-cyan)' }, scss: { glyph: '#', color: 'var(--color-cyan)' },
    html: { glyph: '<>', color: 'var(--color-red)' }, xml: { glyph: '<>', color: 'var(--color-red)' }, svg: { glyph: '<>', color: 'var(--color-cyan)' },
    py: { glyph: 'PY', color: 'var(--color-green)' },
    sh: { glyph: '$', color: 'var(--color-green)' }, bash: { glyph: '$', color: 'var(--color-green)' },
    yml: { glyph: 'Y', color: 'var(--color-purple)' }, yaml: { glyph: 'Y', color: 'var(--color-purple)' },
    png: { glyph: 'IMG', color: 'var(--color-cyan)' }, jpg: { glyph: 'IMG', color: 'var(--color-cyan)' }, jpeg: { glyph: 'IMG', color: 'var(--color-cyan)' }, gif: { glyph: 'IMG', color: 'var(--color-cyan)' }, webp: { glyph: 'IMG', color: 'var(--color-cyan)' },
    lock: { glyph: 'L', color: 'var(--color-text-tertiary)' },
    csv: { glyph: 'CSV', color: 'var(--color-orange)' }, tsv: { glyph: 'CSV', color: 'var(--color-orange)' },
  };
  return map[ext] ?? { glyph: '·', color: 'var(--color-text-secondary)' };
}
