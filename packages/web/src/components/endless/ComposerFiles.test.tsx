import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Composer } from './EndlessColumn';
import { useEndless } from '../../stores/endless';
import { api } from '../../api/client';
import { chatDocType, CHAT_ACCEPT } from '../../lib/image-attach';

// 2026-10-28: a PDF could not be attached in Chat on a phone. The picker hid PDFs (accept = images),
// a pasted PDF was ignored without a word, and the daemon refused anything but four image types.

let saved: ReturnType<typeof useEndless.getState>;
beforeEach(() => {
  localStorage.clear();
  saved = useEndless.getState();
  useEndless.setState({ filter: null, projects: [], turn: { status: 'idle', error: null } });
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => { useEndless.setState(saved, true); });
});

const bytes = new Uint8Array([37, 80, 68, 70]); // %PDF
const file = (name: string, type: string) => {
  const f = new File([bytes], name, { type });
  Object.defineProperty(f, 'arrayBuffer', { value: async () => bytes.buffer });
  return f;
};
const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
const input = () => document.querySelector('input[type="file"]') as HTMLInputElement;

describe('Chat composer: documents', () => {
  it('the picker offers PDFs and text documents, not only images', () => {
    render(<Composer />);
    expect(input().accept).toBe(CHAT_ACCEPT);
    expect(input().accept).toContain('application/pdf');
    expect(input().accept).toContain('.pdf');
  });

  it('a picked PDF shows as a chip with its name, and goes out as a file next to the text', async () => {
    const send = vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    render(<Composer />);
    fireEvent.change(input(), { target: { files: [file('Q3 report.pdf', 'application/pdf')] } });
    expect(await screen.findByRole('button', { name: 'Remove file' })).toBeInTheDocument();
    expect(screen.getByText('Q3 report.pdf')).toBeInTheDocument();
    fireEvent.change(box(), { target: { value: 'summarise this' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledWith('summarise this', null, [], [expect.objectContaining({ name: 'Q3 report.pdf', media_type: 'application/pdf', data: expect.any(String) })]));
  });

  it('a pasted PDF attaches (and is not pasted as text); a PDF alone can be sent', async () => {
    const send = vi.spyOn(api, 'endlessSend').mockResolvedValue({ ok: true });
    render(<Composer />);
    const ev = fireEvent.paste(box(), { clipboardData: { files: [file('a.pdf', 'application/pdf')], types: ['Files'] } });
    expect(ev).toBe(false);
    await screen.findByRole('button', { name: 'Remove file' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledWith('', null, [], [expect.objectContaining({ media_type: 'application/pdf' })]));
  });

  it('a phone that gives no type for a .pdf still attaches it; the chip can be removed', async () => {
    render(<Composer />);
    fireEvent.change(input(), { target: { files: [file('scan.pdf', '')] } });
    const remove = await screen.findByRole('button', { name: 'Remove file' });
    fireEvent.click(remove);
    expect(screen.queryByRole('button', { name: 'Remove file' })).toBeNull();
  });

  it('a type Chat does not take is named in a notice, not dropped silently', async () => {
    render(<Composer />);
    fireEvent.change(input(), { target: { files: [file('archive.zip', 'application/zip')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/archive\.zip not attached: Chat takes images .* and documents \(PDF, TXT, MD, CSV, JSON\)/);
    expect(screen.queryByRole('button', { name: 'Remove file' })).toBeNull();
  });
});

describe('chatDocType', () => {
  it('takes the documents by type, falls back to the extension when the type is empty or generic, and refuses the rest', () => {
    expect(chatDocType({ type: 'application/pdf', name: 'x' })).toBe('application/pdf');
    expect(chatDocType({ type: '', name: 'notes.MD' })).toBe('text/markdown');
    expect(chatDocType({ type: 'application/octet-stream', name: 'data.csv' })).toBe('text/csv');
    expect(chatDocType({ type: 'application/zip', name: 'a.zip' })).toBeNull();
    expect(chatDocType({ type: 'application/zip', name: 'a.pdf' })).toBeNull(); // a real type wins over the name
    expect(chatDocType({ type: 'image/png', name: 'a.png' })).toBeNull();
  });
});
