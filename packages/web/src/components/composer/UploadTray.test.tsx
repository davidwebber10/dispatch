import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { UploadTray, useInboxUploads } from './UploadTray';
import { api } from '../../api/client';

type Ctl = { progress: (f: number) => void; resolve: (v: unknown) => void; reject: (e: unknown) => void; abort: ReturnType<typeof vi.fn> };

function stubUpload() {
  const ctls: Ctl[] = [];
  vi.spyOn(api, 'uploadInboxTracked').mockImplementation((_s, _f, onProgress) => {
    let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const abort = vi.fn(() => reject(new DOMException('cancelled', 'AbortError')));
    ctls.push({ progress: onProgress, resolve, reject, abort });
    return { promise: promise as never, abort };
  });
  return ctls;
}

function Host({ onUploaded }: { onUploaded: (res: { path: string }, f: File) => void | Promise<void> }) {
  const u = useInboxUploads('s1', onUploaded as never);
  return (
    <>
      <button onClick={() => u.start(new File(['x'], 'shot.png', { type: 'image/png' }))}>pick</button>
      <span data-testid="busy">{String(u.busy)}</span>
      <UploadTray uploads={u.uploads} onCancel={u.cancel} />
    </>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('upload tray', () => {
  it('shows a tile with the percentage while uploading, then hands the file on and clears it', async () => {
    const ctls = stubUpload();
    const done = vi.fn();
    render(<Host onUploaded={done} />);
    fireEvent.click(screen.getByText('pick'));
    expect(screen.getByRole('status', { name: 'shot.png: uploading 0%' })).toBeInTheDocument();
    expect(screen.getByTestId('busy').textContent).toBe('true');
    act(() => ctls[0].progress(0.42));
    expect(screen.getByText('42%')).toBeInTheDocument();
    await act(async () => { ctls[0].resolve({ ok: true, path: '.dispatch/inbox/shot.png', absolutePath: '/x' }); });
    await waitFor(() => expect(screen.queryByTestId('upload-tray')).toBeNull());
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ path: '.dispatch/inbox/shot.png' }), expect.any(File));
    expect(screen.getByTestId('busy').textContent).toBe('false');
  });

  it('the × cancels a running upload: the request is aborted and the file is never handed on', async () => {
    const ctls = stubUpload();
    const done = vi.fn();
    render(<Host onUploaded={done} />);
    fireEvent.click(screen.getByText('pick'));
    act(() => ctls[0].progress(0.3));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload of shot.png' }));
    expect(ctls[0].abort).toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('upload-tray')).toBeNull();
    expect(done).not.toHaveBeenCalled();
  });

  it('a failed upload stays, marked, until its × clears it', async () => {
    const ctls = stubUpload();
    render(<Host onUploaded={vi.fn()} />);
    fireEvent.click(screen.getByText('pick'));
    await act(async () => { ctls[0].reject(new Error('upload failed: 500')); });
    expect(await screen.findByRole('status', { name: 'shot.png: upload failed' })).toBeInTheDocument();
    expect(screen.getByTestId('busy').textContent).toBe('false'); // a failure does not block sending
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    expect(screen.queryByTestId('upload-tray')).toBeNull();
  });
});
