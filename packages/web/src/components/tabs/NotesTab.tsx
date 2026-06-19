import { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';

export function NotesTab({ terminal }: { terminal: Terminal }) {
  const html = (terminal.config?.html as string) || '';
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  const editor = useEditor({
    extensions: [StarterKit],
    content: html,
    onUpdate: ({ editor }) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void api.updateTerminal(terminal.id, { config: { ...terminal.config, html: editor.getHTML() } });
      }, 400);
    },
  });

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 20, background: 'var(--color-base)', fontSize: 14, lineHeight: 1.6 }}>
      <EditorContent editor={editor} />
    </div>
  );
}
