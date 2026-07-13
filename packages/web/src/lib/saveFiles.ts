/** A file living on the daemon, addressed by its byte-route URL. */
export interface RemoteFile {
  url: string;
  name: string;
}

/** Last-resort download: the browser decides where it lands (usually ~/Downloads). */
function downloadViaAnchor(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Save a remote file to the user's device. Prefers the File System Access API — a true native
 * "Save As" location picker — on Chromium desktop; falls back to a normal anchor download
 * everywhere else (Safari PWA, Firefox, mobile), which lands in Downloads or prompts if the
 * browser is set to ask where to save each file. Exported for direct testing.
 */
export async function saveFileAs(url: string, suggestedName: string): Promise<void> {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<any> }).showSaveFilePicker;
  if (typeof picker === 'function') {
    let handle: any = null;
    try {
      handle = await picker({ suggestedName });
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // user cancelled the dialog — do nothing
      handle = null; // any other picker failure: fall through to the anchor download
    }
    if (handle) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const writable = await handle.createWritable();
      await res.body!.pipeTo(writable);
      return;
    }
  }
  downloadViaAnchor(url, suggestedName);
}

/**
 * Save a whole selection. The browser has no multi-file save dialog, and N sequential save
 * dialogs would be unusable — so we ask for ONE destination folder and stream every file into
 * it under its real name. Falls back to N plain downloads where the picker doesn't exist
 * (Safari, Firefox, iOS), which land in the browser's download folder.
 */
export async function saveFilesAs(files: RemoteFile[]): Promise<void> {
  if (files.length === 0) return;
  if (files.length === 1) return saveFileAs(files[0].url, files[0].name);

  const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<any> }).showDirectoryPicker;
  if (typeof picker === 'function') {
    let dir: any = null;
    try {
      dir = await picker({ mode: 'readwrite' });
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // user cancelled — do nothing
      dir = null; // any other picker failure: fall through to plain downloads
    }
    if (dir) {
      const failed: string[] = [];
      for (const f of files) {
        try {
          const res = await fetch(f.url);
          if (!res.ok) throw new Error(`download failed: ${res.status}`);
          const handle = await dir.getFileHandle(f.name, { create: true });
          const writable = await handle.createWritable();
          await res.body!.pipeTo(writable);
        } catch {
          failed.push(f.name);
        }
      }
      if (failed.length > 0) {
        const succeeded = files.length - failed.length;
        throw new Error(`Saved ${succeeded} of ${files.length}. Failed: ${failed.join(', ')}`);
      }
      return;
    }
  }
  for (const f of files) downloadViaAnchor(f.url, f.name);
}
