import { ChatImage } from '../ChatImage';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';

/**
 * An image file opened from the Files pane. This exists because FileEditorTab cannot show one:
 * it fetches through /files/read, which is a utf-8 JSON route, so binary arrives as mojibake.
 * Here we point straight at the /files/image byte route and reuse ChatImage, which already
 * implements the lightbox, pinch-zoom, copy-to-clipboard and download.
 */
export function ImageFileTab({ terminal }: { terminal: Terminal }) {
  const path = (terminal.config?.path as string) || terminal.label;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-terminal)' }}>
      <div style={{ height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', background: 'var(--color-terminal)', borderBottom: '1px solid var(--color-border)', fontSize: 13 }}>
        <span style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 24 }}>
        <ChatImage src={api.imageUrl(terminal.sessionId, path)} alt={terminal.label} maxHeight="80vh" />
      </div>
    </div>
  );
}
