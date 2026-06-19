import { fileMeta } from '../../lib/fileType';

export function FileIcon({ name, isDir, size = 16 }: { name: string; isDir: boolean; size?: number }) {
  if (isDir) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }} aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="#4F90D0" opacity="0.9" />
      </svg>
    );
  }
  const { glyph, color } = fileMeta(name);
  return (
    <span style={{
      width: size, height: size, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      font: '600 8px/1 var(--font-mono)', color, border: `1px solid ${color}`, borderRadius: 3,
    }}>{glyph}</span>
  );
}
