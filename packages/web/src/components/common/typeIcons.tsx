import {
  FileTs, FileJs, FileCss, FileHtml, FilePy, FileImage, FileCode, FileText, File as FileGlyph,
  type Icon,
} from '@phosphor-icons/react';
import type { TerminalType } from '../../api/types';

// Provider distinction in thread rows is shown as a small colored dot.
export function providerColor(type: TerminalType): string {
  switch (type) {
    case 'claude-code': return 'var(--color-blue)'; // Claude → blue
    case 'codex': return 'var(--color-green)'; // Codex → green
    case 'grok': return 'var(--color-text-primary)'; // Grok → xAI white
    case 'opencode': return 'var(--color-orange)'; // OpenCode → open-model amber
    case 'shell': return 'var(--color-text-secondary)'; // Terminal → neutral
    case 'browser': return 'var(--color-cyan)';
    case 'notes': return 'var(--color-purple)';
    default: return 'var(--color-text-secondary)';
  }
}

export function fileVisual(name: string): { Icon: Icon; color: string } {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx'].includes(ext)) return { Icon: FileTs, color: 'var(--color-blue)' };
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return { Icon: FileJs, color: 'var(--color-yellow)' };
  if (ext === 'json') return { Icon: FileCode, color: 'var(--color-yellow)' };
  if (['css', 'scss', 'less'].includes(ext)) return { Icon: FileCss, color: 'var(--color-cyan)' };
  if (['html', 'htm', 'xml', 'svg', 'vue'].includes(ext)) return { Icon: FileHtml, color: 'var(--color-red)' };
  if (ext === 'py') return { Icon: FilePy, color: 'var(--color-green)' };
  if (['md', 'markdown', 'mdx', 'txt'].includes(ext)) return { Icon: FileText, color: 'var(--color-purple)' };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'].includes(ext)) return { Icon: FileImage, color: 'var(--color-cyan)' };
  if (['sh', 'bash', 'zsh', 'go', 'rs', 'rb', 'java', 'c', 'cpp', 'h'].includes(ext)) return { Icon: FileCode, color: 'var(--color-green)' };
  if (['yml', 'yaml', 'toml', 'ini', 'env', 'lock'].includes(ext)) return { Icon: FileCode, color: 'var(--color-text-secondary)' };
  return { Icon: FileGlyph, color: 'var(--color-text-secondary)' };
}
