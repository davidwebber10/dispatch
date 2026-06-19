import {
  Sparkle, Hexagon, Terminal as TerminalIcon, Globe, Note,
  FileTs, FileJs, FileCss, FileHtml, FilePy, FileImage, FileCode, FileText, File as FileGlyph,
  type Icon,
} from '@phosphor-icons/react';
import type { TerminalType } from '../../api/types';

export function providerVisual(type: TerminalType): { Icon: Icon; color: string } {
  switch (type) {
    case 'claude-code': return { Icon: Sparkle, color: '#3ECF6A' };
    case 'codex': return { Icon: Hexagon, color: '#5A8DD6' };
    case 'shell': return { Icon: TerminalIcon, color: '#9A9AA2' };
    case 'browser': return { Icon: Globe, color: '#56B6C2' };
    case 'notes': return { Icon: Note, color: '#C792EA' };
    case 'file': return { Icon: FileText, color: '#8E8E96' };
    default: return { Icon: TerminalIcon, color: '#9A9AA2' };
  }
}

export function fileVisual(name: string): { Icon: Icon; color: string } {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx'].includes(ext)) return { Icon: FileTs, color: '#4F90D0' };
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return { Icon: FileJs, color: '#E5C07B' };
  if (ext === 'json') return { Icon: FileCode, color: '#E5C07B' };
  if (['css', 'scss', 'less'].includes(ext)) return { Icon: FileCss, color: '#56B6C2' };
  if (['html', 'htm', 'xml', 'svg', 'vue'].includes(ext)) return { Icon: FileHtml, color: '#E06C75' };
  if (ext === 'py') return { Icon: FilePy, color: '#7FBE6E' };
  if (['md', 'markdown', 'mdx', 'txt'].includes(ext)) return { Icon: FileText, color: '#C792EA' };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'].includes(ext)) return { Icon: FileImage, color: '#56B6C2' };
  if (['sh', 'bash', 'zsh', 'go', 'rs', 'rb', 'java', 'c', 'cpp', 'h'].includes(ext)) return { Icon: FileCode, color: '#7FBE6E' };
  if (['yml', 'yaml', 'toml', 'ini', 'env', 'lock'].includes(ext)) return { Icon: FileCode, color: '#8E8E96' };
  return { Icon: FileGlyph, color: '#8E8E96' };
}
