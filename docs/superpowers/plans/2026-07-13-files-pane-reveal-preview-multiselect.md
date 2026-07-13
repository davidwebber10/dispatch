# Files Pane: Reveal / Preview / Multi-Select — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Reveal-in-Finder, inline image preview, and multi-select with a selection-aware right-click menu to the Dispatch Files pane.

**Architecture:** The daemon gains one capability probe (`GET /api/state/host`) and one action (`POST /api/sessions/:id/files/reveal`) that shells out to macOS `open -R` — but only when the requesting browser is on the same machine, decided from the unforgeable socket peer address. The web side wires up three already-built-but-unused pieces (`isImage()`, `api.imageUrl()`, `ChatImage`) and adds Finder-style multi-select to `FilesPane`.

**Tech Stack:** Express 4 + better-sqlite3 + vitest/supertest (core); React 18 + Zustand + vitest/@testing-library (web). Package manager is **pnpm** (workspace).

## Global Constraints

- **Never use `req.ip` for the loopback decision.** It honors `X-Forwarded-For` when `trust proxy` is on and is therefore forgeable by a remote client. Always use `req.socket.remoteAddress`.
- **Never build a shell string for `open`.** Always `execFile('open', [...args])` with an argument array, so a filename containing `$(...)`, `;`, or a quote is inert. Mirrors `packages/core/src/routes/git.ts:15`.
- **All file paths stay inside the existing strict `resolveSafe` working-dir sandbox.** Never use `resolveRead` (its absolute-path escape hatch is read-only by design).
- **Do not `vi.mock('child_process')` in `packages/core/tests/routes/files.test.ts`.** `createApp()` shells out during boot (`server.ts:223`); mocking it globally breaks the app under test. Mock the `reveal.js` module by path instead.
- **Never fetch a binary file through `/files/read`.** It is a `utf-8` JSON route (`files.ts:86`) and will return mojibake.
- Run tests from the repo root: `pnpm --filter dispatch-server test` and `pnpm --filter dispatch-web test`.

---

## File Structure

**Create**
- `packages/core/src/files/reveal.ts` — loopback/platform predicates + the `open -R` shell-out. Isolated so the route test can mock it without touching `child_process`.
- `packages/core/tests/files/reveal.test.ts` — table tests for the predicates; `execFile` arg-array test.
- `packages/web/src/lib/clipboard.ts` — `fetchAsPngBlob` (lifted out of `ChatImage`) + `copyImageToClipboard`.
- `packages/web/src/lib/saveFiles.ts` — `saveFileAs` (moved from `FilesPane`) + new `saveFilesAs` (directory picker).
- `packages/web/src/lib/saveFiles.test.ts`
- `packages/web/src/stores/host.ts` — `{ platform, canReveal }`.
- `packages/web/src/components/tabs/ImageFileTab.tsx`
- `packages/web/src/components/tabs/ImageFileTab.test.tsx`

**Modify**
- `packages/core/src/routes/state.ts` — add `GET /host`.
- `packages/core/src/routes/files.ts` — add `POST /reveal`; add `.avif`/`.bmp` to `IMAGE_MIME` (line 99).
- `packages/core/tests/routes/files.test.ts` — reveal route + avif/bmp tests.
- `packages/web/src/components/ChatImage.tsx` — import the lifted helpers; add optional `maxHeight` prop.
- `packages/web/src/components/tabs/TabHost.tsx:70` — branch `file` tabs on `isImage()`.
- `packages/web/src/api/client.ts` — add `getHost`, `revealFiles`.
- `packages/web/src/App.tsx:64` — bootstrap the host store.
- `packages/web/src/components/inspector/FilesPane.tsx` — multi-select + selection-aware menu; remove the local `saveFileAs`.
- `packages/web/src/components/inspector/FilesPane.test.tsx` — selection + menu tests.

---

### Task 1: Reveal predicates + shell-out (core)

**Files:**
- Create: `packages/core/src/files/reveal.ts`
- Test: `packages/core/tests/files/reveal.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isLoopbackAddress(addr: string | undefined): boolean`
  - `canReveal(addr: string | undefined, platform?: string): boolean`
  - `revealInFinder(absPaths: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/files/reveal.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked here and ONLY here — this file never imports createApp, so faking child_process
// cannot disturb the server's own boot-time shell-outs.
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => cb(null)),
}));

import { execFile } from 'child_process';
import { isLoopbackAddress, canReveal, revealInFinder } from '../../src/files/reveal.js';

describe('isLoopbackAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.0.0.53', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['192.168.1.20', false],
    ['100.83.12.4', false],   // Tailscale CGNAT — the Mac mini case
    ['::ffff:10.0.0.9', false],
    ['', false],
  ])('%s -> %s', (addr, expected) => {
    expect(isLoopbackAddress(addr)).toBe(expected);
  });

  it('is false for undefined', () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('canReveal', () => {
  it('allows loopback on macOS', () => {
    expect(canReveal('127.0.0.1', 'darwin')).toBe(true);
  });
  it('refuses a remote client even on macOS', () => {
    expect(canReveal('100.83.12.4', 'darwin')).toBe(false);
  });
  it('refuses loopback on a non-macOS host (no Finder)', () => {
    expect(canReveal('127.0.0.1', 'linux')).toBe(false);
  });
});

describe('revealInFinder', () => {
  beforeEach(() => vi.mocked(execFile).mockClear());

  it('passes every path as a separate argv entry, never a shell string', async () => {
    await revealInFinder(['/w/a.png', '/w/b.png']);
    const [cmd, args] = vi.mocked(execFile).mock.calls[0];
    expect(cmd).toBe('open');
    expect(args).toEqual(['-R', '/w/a.png', '/w/b.png']);
  });

  it('does not interpolate a hostile filename', async () => {
    await revealInFinder(['/w/$(rm -rf ~).png']);
    const [, args] = vi.mocked(execFile).mock.calls[0];
    expect(args).toEqual(['-R', '/w/$(rm -rf ~).png']); // inert: it is one argv element
  });

  it('rejects when open fails', async () => {
    vi.mocked(execFile).mockImplementationOnce(
      ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => cb(new Error('boom'))) as never,
    );
    await expect(revealInFinder(['/w/a.png'])).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter dispatch-server test -- reveal`
Expected: FAIL — `Cannot find module '../../src/files/reveal.js'`

- [ ] **Step 3: Implement**

Create `packages/core/src/files/reveal.ts`:

```ts
import { execFile } from 'child_process';

/**
 * True when the peer socket address is loopback — i.e. the browser making this request is
 * running on THIS machine, so the daemon's Finder is the user's Finder.
 *
 * Callers MUST pass `req.socket.remoteAddress`, never `req.ip`: Express derives `req.ip` from
 * `X-Forwarded-For` when `trust proxy` is enabled, so a remote client could simply claim to be
 * 127.0.0.1. The socket peer address is set by the kernel and cannot be forged.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  // Node reports IPv4 peers on a dual-stack socket as "::ffff:127.0.0.1".
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\./.test(a); // 127.0.0.0/8 is the whole loopback range
}

/**
 * Reveal is only meaningful when Finder exists AND the browser is on this machine. On the
 * headless Mac mini, revealing would pop Finder on a screen nobody is looking at.
 */
export function canReveal(addr: string | undefined, platform: string = process.platform): boolean {
  return platform === 'darwin' && isLoopbackAddress(addr);
}

/**
 * Select the given absolute paths in Finder. Passing several paths at once makes Finder open
 * them ALREADY MULTI-SELECTED — which is the whole point: Finder's own Cmd-C pastes into upload
 * fields, something a web page's clipboard can never do for arbitrary files.
 *
 * Argument array, never a shell string: a file named `$(rm -rf ~).png` is just a filename.
 */
export function revealInFinder(absPaths: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', ['-R', ...absPaths], { timeout: 3000 }, (err) => (err ? reject(err) : resolve()));
  });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dispatch-server test -- reveal`
Expected: PASS (all 13)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/files/reveal.ts packages/core/tests/files/reveal.test.ts
git commit -m "feat(core): loopback-gated reveal-in-Finder primitives"
```

---

### Task 2: `GET /api/state/host` capability probe

**Files:**
- Modify: `packages/core/src/routes/state.ts` (imports at top; new route before `return router`)
- Test: `packages/core/tests/routes/state-host.test.ts` (create)

**Interfaces:**
- Consumes: `canReveal` from Task 1.
- Produces: `GET /api/state/host` → `{ platform: string; canReveal: boolean }`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/routes/state-host.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from '../../src/server.js';
import { initSchema } from '../../src/db/schema.js';

describe('GET /api/state/host', () => {
  let app: any;

  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
  });

  it('reports the platform and the reveal capability', async () => {
    const res = await request(app).get('/api/state/host');
    expect(res.status).toBe(200);
    expect(res.body.platform).toBe(process.platform);
    // supertest connects over loopback, so on macOS this is true.
    expect(res.body.canReveal).toBe(process.platform === 'darwin');
  });

  it('is not fooled by a forged X-Forwarded-For', async () => {
    // A remote client cannot LOSE the capability by lying either — the point is that the
    // header is ignored entirely and only the real socket address counts.
    const res = await request(app).get('/api/state/host').set('X-Forwarded-For', '8.8.8.8');
    expect(res.body.canReveal).toBe(process.platform === 'darwin');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter dispatch-server test -- state-host`
Expected: FAIL — 404, because `/api/state/host` does not exist.

- [ ] **Step 3: Implement**

In `packages/core/src/routes/state.ts`, add to the imports at the top:

```ts
import { canReveal } from '../files/reveal.js';
```

Then insert this route immediately before the final `return router;`:

```ts
  // GET /api/state/host — what can this daemon do for the browser asking?
  // `canReveal` is true only on macOS AND when the request came over loopback (see
  // files/reveal.ts). Purely a UI affordance: POST /files/reveal enforces it again.
  router.get('/host', (req, res) => {
    res.json({
      platform: process.platform,
      canReveal: canReveal(req.socket.remoteAddress),
    });
  });
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dispatch-server test -- state-host`
Expected: PASS (2)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routes/state.ts packages/core/tests/routes/state-host.test.ts
git commit -m "feat(core): GET /api/state/host reports reveal capability"
```

---

### Task 3: `POST /files/reveal` + avif/bmp image support

**Files:**
- Modify: `packages/core/src/routes/files.ts` (imports; `IMAGE_MIME` at line 99; new route after `/download`)
- Test: `packages/core/tests/routes/files.test.ts`

**Interfaces:**
- Consumes: `canReveal`, `revealInFinder` from Task 1.
- Produces: `POST /api/sessions/:id/files/reveal` body `{ paths: string[] }` → `{ ok: true }`

- [ ] **Step 1: Write the failing test**

At the TOP of `packages/core/tests/routes/files.test.ts`, above the existing imports, add the module mock. Mock the reveal module **by path** — **not** `child_process`, which `createApp` itself needs at boot (`server.ts:223`). Mocking `canReveal` too is what lets the deny path be tested on **any** platform, rather than only on a non-macOS machine; the real `canReveal` logic is table-tested in Task 1.

```ts
import { vi } from 'vitest';

vi.mock('../../src/files/reveal.js', () => ({
  isLoopbackAddress: vi.fn(),
  canReveal: vi.fn(() => true),
  revealInFinder: vi.fn(async () => {}),
}));

import { canReveal, revealInFinder } from '../../src/files/reveal.js';
```

Then append these tests inside the existing `describe('file routes', ...)` block:

```ts
  it('serves an avif image rather than 415', async () => {
    fs.writeFileSync(path.join(tmpDir, 'shot.avif'), Buffer.from([0x00, 0x01, 0x02]));
    const res = await request(app).get('/api/sessions/s1/files/image?path=shot.avif');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/avif');
  });

  it('serves a bmp image rather than 415', async () => {
    fs.writeFileSync(path.join(tmpDir, 'shot.bmp'), Buffer.from([0x42, 0x4d]));
    const res = await request(app).get('/api/sessions/s1/files/image?path=shot.bmp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/bmp');
  });

  describe('POST /reveal', () => {
    beforeEach(() => {
      vi.mocked(revealInFinder).mockClear();
      vi.mocked(canReveal).mockReturnValue(true); // capable by default; the deny test flips it
    });

    it('reveals every requested path, resolved to absolute', async () => {
      fs.writeFileSync(path.join(tmpDir, 'b.png'), 'x');
      const res = await request(app)
        .post('/api/sessions/s1/files/reveal')
        .send({ paths: ['hello.txt', 'b.png'] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(vi.mocked(revealInFinder)).toHaveBeenCalledWith([
        path.join(tmpDir, 'hello.txt'),
        path.join(tmpDir, 'b.png'),
      ]);
    });

    it('decides capability from the socket peer address, not req.ip', async () => {
      await request(app).post('/api/sessions/s1/files/reveal').send({ paths: ['hello.txt'] });
      // The route must hand canReveal the raw socket address. supertest connects over loopback.
      const [addr] = vi.mocked(canReveal).mock.calls[0];
      expect(addr).toMatch(/^(::1|::ffff:)?127\.|^::1$/);
    });

    it('never shells out when the caller is not capable', async () => {
      vi.mocked(canReveal).mockReturnValue(false); // remote client, or a non-macOS daemon
      const res = await request(app)
        .post('/api/sessions/s1/files/reveal')
        .send({ paths: ['hello.txt'] });
      expect(res.status).toBe(403);
      expect(vi.mocked(revealInFinder)).not.toHaveBeenCalled();
    });

    it('rejects path traversal', async () => {
      const res = await request(app)
        .post('/api/sessions/s1/files/reveal')
        .send({ paths: ['../../etc/passwd'] });
      expect(res.status).toBe(403);
      expect(vi.mocked(revealInFinder)).not.toHaveBeenCalled();
    });

    it('rejects an empty selection', async () => {
      const res = await request(app).post('/api/sessions/s1/files/reveal').send({ paths: [] });
      expect(res.status).toBe(400);
      expect(vi.mocked(revealInFinder)).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter dispatch-server test -- files`
Expected: FAIL — avif/bmp return 415; `/reveal` returns 404.

- [ ] **Step 3: Implement**

In `packages/core/src/routes/files.ts`, add to the imports at the top:

```ts
import { canReveal, revealInFinder } from '../files/reveal.js';
```

Extend `IMAGE_MIME` (currently at line 99) so it matches the web's `isImage()`, which already
accepts these two — today they 415 and render as a broken image:

```ts
  const IMAGE_MIME: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
  };
```

Add this route immediately after the `/download` handler:

```ts
  // POST /api/sessions/:id/files/reveal — select the given paths in the macOS Finder.
  //
  // Only ever valid when the browser is on the SAME machine as the daemon: on the headless
  // mini this would pop Finder on a screen nobody is looking at. `canReveal` reads the
  // unforgeable socket peer address (NOT req.ip, which trusts X-Forwarded-For). The client's
  // menu already hides this item — this check is the one that actually enforces it.
  //
  // Revealing the whole selection at once is deliberate: Finder opens with all of them
  // selected, and Finder's Cmd-C *does* paste into a browser upload field — which a web
  // page's own clipboard can never do for arbitrary file types.
  router.post('/reveal', async (req, res) => {
    if (!canReveal(req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Reveal is only available on the machine running Dispatch' });
    }
    const session = (req as any).session;
    const paths = req.body?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'Missing paths' });
    }

    const resolved: string[] = [];
    for (const p of paths) {
      const abs = typeof p === 'string' ? resolveSafe(session.workingDir, p) : null;
      if (!abs) return res.status(403).json({ error: 'Path traversal not allowed' });
      resolved.push(abs);
    }

    try {
      await revealInFinder(resolved);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dispatch-server test -- files`
Expected: PASS (existing 12 + 7 new = 19)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/routes/files.ts packages/core/tests/routes/files.test.ts
git commit -m "feat(core): POST /files/reveal + avif/bmp image support"
```

---

### Task 4: Shared clipboard lib (extract from ChatImage)

**Files:**
- Create: `packages/web/src/lib/clipboard.ts`
- Modify: `packages/web/src/components/ChatImage.tsx` (delete the local `fetchAsPngBlob` + `CLIPBOARD_IMAGE_SUPPORTED`; import them; add `maxHeight` prop)
- Test: `packages/web/src/lib/clipboard.test.ts` (create)

**Interfaces:**
- Produces:
  - `clipboardImageSupported(): boolean`
  - `fetchAsPngBlob(src: string): Promise<Blob>`
  - `copyImageToClipboard(src: string): Promise<void>`
  - `ChatImage` gains `maxHeight?: number | string` (default `320`)

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/clipboard.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clipboardImageSupported, copyImageToClipboard } from './clipboard';

class FakeClipboardItem {
  constructor(public items: Record<string, Blob>) {}
}

describe('clipboardImageSupported', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is false when ClipboardItem is absent', () => {
    vi.stubGlobal('ClipboardItem', undefined);
    expect(clipboardImageSupported()).toBe(false);
  });

  it('is true when clipboard.write and ClipboardItem both exist', () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn() } });
    expect(clipboardImageSupported()).toBe(true);
  });
});

describe('copyImageToClipboard', () => {
  const write = vi.fn(async () => {});

  beforeEach(() => {
    write.mockClear();
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('writes a png blob straight through without re-encoding', async () => {
    const png = new Blob(['fake'], { type: 'image/png' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => png })));

    await copyImageToClipboard('/api/sessions/s1/files/image?path=a.png');

    expect(write).toHaveBeenCalledTimes(1);
    const [[item]] = write.mock.calls as unknown as [[FakeClipboardItem]];
    expect(item.items['image/png']).toBe(png);
  });

  it('rejects when the clipboard refuses the write', async () => {
    const png = new Blob(['fake'], { type: 'image/png' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => png })));
    write.mockRejectedValueOnce(new Error('NotAllowedError'));

    await expect(copyImageToClipboard('/x.png')).rejects.toThrow('NotAllowedError');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter dispatch-web test -- clipboard`
Expected: FAIL — cannot resolve `./clipboard`

- [ ] **Step 3: Implement**

Create `packages/web/src/lib/clipboard.ts`:

```ts
/**
 * Image → clipboard, shared by the chat lightbox (ChatImage) and the Files pane.
 *
 * Scope note: a web page can put an IMAGE on the clipboard and nothing else. `ClipboardItem`
 * only supports a narrow MIME allowlist (in practice image/png plus text), Chrome throws on
 * more than one ClipboardItem at a time, and `<input type=file>` does not accept paste at all.
 * So there is no browser path to "copy these 4 PDFs and paste them into an upload field" —
 * that is what Reveal-in-Finder exists for.
 */

/**
 * Feature-detected at CALL time, not module load: the test suite (and any SSR pass) evaluates
 * this module before it can stub navigator/ClipboardItem.
 */
export function clipboardImageSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.clipboard &&
    typeof navigator.clipboard.write === 'function' &&
    typeof (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem === 'function'
  );
}

/**
 * Fetch `src` (data: URI or same-origin byte route) as a Blob, converting to PNG if it isn't
 * already — paste targets (Slack, Docs, Photoshop, ...) reliably accept PNG and are
 * inconsistent with everything else. The conversion draws through a blob: URL, which is always
 * same-origin to this page, so the canvas is never tainted even if `src` were cross-origin.
 */
export async function fetchAsPngBlob(src: string): Promise<Blob> {
  const res = await fetch(src);
  const blob = await res.blob();
  if (blob.type === 'image/png') return blob;
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('no 2d context')); return; }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('canvas toBlob failed'))), 'image/png');
      };
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Put `src` on the system clipboard as a PNG. Rejects if the browser refuses the write. */
export async function copyImageToClipboard(src: string): Promise<void> {
  const blob = await fetchAsPngBlob(src);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
```

Now edit `packages/web/src/components/ChatImage.tsx`:

1. Add to the imports at the top:

```ts
import { clipboardImageSupported, copyImageToClipboard } from '../lib/clipboard';
```

2. **Delete** the `CLIPBOARD_IMAGE_SUPPORTED` const (lines 30-36) and the whole local
   `fetchAsPngBlob` function (lines 42-72).

3. Change the signature (line 130) to accept an optional height cap:

```ts
export function ChatImage({ src, alt, maxHeight = 320 }: { src: string; alt?: string; maxHeight?: number | string }) {
```

4. Replace `handleCopy` (lines 155-166) with:

```ts
  async function handleCopy() {
    if (!clipboardImageSupported()) return;
    try {
      await copyImageToClipboard(src);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    } finally {
      setTimeout(() => setCopyState('idle'), 1600);
    }
  }
```

5. Replace every remaining `CLIPBOARD_IMAGE_SUPPORTED` reference with `clipboardImageSupported()`
   (the `copyTitle` ternary at line 200, and the button's `disabled` + `style` at lines 246 and 249).

6. In the thumbnail `<img>` style (line 215), swap the hardcoded cap for the prop:

```ts
          maxHeight,
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dispatch-web test -- clipboard ChatImage`
Expected: PASS — new clipboard tests green, and any existing ChatImage tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/clipboard.ts packages/web/src/lib/clipboard.test.ts packages/web/src/components/ChatImage.tsx
git commit -m "refactor(web): lift image-clipboard helpers out of ChatImage into lib"
```

---

### Task 5: `lib/saveFiles.ts` — single + multi Save As

**Files:**
- Create: `packages/web/src/lib/saveFiles.ts`, `packages/web/src/lib/saveFiles.test.ts`
- Modify: `packages/web/src/components/inspector/FilesPane.tsx` (delete the local `saveFileAs`, lines 28-58; import from the lib instead)

**Interfaces:**
- Produces:
  - `interface RemoteFile { url: string; name: string }`
  - `saveFileAs(url: string, suggestedName: string): Promise<void>`
  - `saveFilesAs(files: RemoteFile[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/saveFiles.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveFilesAs } from './saveFiles';

function fakeWritable() {
  return { write: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}

describe('saveFilesAs', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { pipeTo: vi.fn(async () => {}) },
    })));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('writes every file into the ONE folder the user picked', async () => {
    const writable = fakeWritable();
    const getFileHandle = vi.fn(async () => ({ createWritable: async () => writable }));
    const showDirectoryPicker = vi.fn(async () => ({ getFileHandle }));
    vi.stubGlobal('showDirectoryPicker', showDirectoryPicker);

    await saveFilesAs([
      { url: '/dl?path=a.png', name: 'a.png' },
      { url: '/dl?path=b.pdf', name: 'b.pdf' },
    ]);

    expect(showDirectoryPicker).toHaveBeenCalledTimes(1); // one dialog, not N
    expect(getFileHandle).toHaveBeenCalledWith('a.png', { create: true });
    expect(getFileHandle).toHaveBeenCalledWith('b.pdf', { create: true });
  });

  it('does nothing when the user cancels the folder dialog', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => { throw abort; }));

    await saveFilesAs([{ url: '/dl?path=a.png', name: 'a.png' }, { url: '/dl?path=b.pdf', name: 'b.pdf' }]);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to one download per file when there is no picker (Safari/iOS)', async () => {
    vi.stubGlobal('showDirectoryPicker', undefined);
    vi.stubGlobal('showSaveFilePicker', undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await saveFilesAs([
      { url: '/dl?path=a.png', name: 'a.png' },
      { url: '/dl?path=b.pdf', name: 'b.pdf' },
    ]);

    expect(click).toHaveBeenCalledTimes(2);
  });

  it('routes a lone file through the single-file save picker', async () => {
    const writable = fakeWritable();
    const showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => writable }));
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);
    vi.stubGlobal('showDirectoryPicker', vi.fn());

    await saveFilesAs([{ url: '/dl?path=a.png', name: 'a.png' }]);

    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'a.png' });
    expect(showDirectoryPicker).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter dispatch-web test -- saveFiles`
Expected: FAIL — cannot resolve `./saveFiles`

- [ ] **Step 3: Implement**

Create `packages/web/src/lib/saveFiles.ts`:

```ts
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
 * Save one remote file to the user's device. Prefers the File System Access API — a true native
 * "Save As" location picker — on Chromium desktop; falls back to a normal anchor download
 * everywhere else (Safari PWA, Firefox, mobile), which lands in Downloads or prompts if the
 * browser is configured to ask.
 */
export async function saveFileAs(url: string, suggestedName: string): Promise<void> {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<any> }).showSaveFilePicker;
  if (typeof picker === 'function') {
    let handle: any = null;
    try {
      handle = await picker({ suggestedName });
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // user cancelled — do nothing
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
      for (const f of files) {
        const res = await fetch(f.url);
        if (!res.ok) throw new Error(`download failed: ${res.status}`);
        const handle = await dir.getFileHandle(f.name, { create: true });
        const writable = await handle.createWritable();
        await res.body!.pipeTo(writable);
      }
      return;
    }
  }
  for (const f of files) downloadViaAnchor(f.url, f.name);
}
```

Now in `packages/web/src/components/inspector/FilesPane.tsx`, **delete** the entire local
`saveFileAs` function (its doc comment and body, lines 28-58) and add to the imports:

```ts
import { saveFileAs, saveFilesAs, type RemoteFile } from '../../lib/saveFiles';
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dispatch-web test -- saveFiles FilesPane`
Expected: PASS — new saveFiles tests green. If `FilesPane.test.tsx` imported `saveFileAs` from
the component, repoint that import at `../../lib/saveFiles`.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/saveFiles.ts packages/web/src/lib/saveFiles.test.ts packages/web/src/components/inspector/FilesPane.tsx
git commit -m "feat(web): multi-file Save As via one directory picker"
```

---

### Task 6: API client + host store + bootstrap

**Files:**
- Modify: `packages/web/src/api/client.ts` (file methods block, ~line 103-126)
- Create: `packages/web/src/stores/host.ts`
- Modify: `packages/web/src/App.tsx` (imports; bootstrap effect at line 64)

**Interfaces:**
- Consumes: `GET /api/state/host` (Task 2), `POST /files/reveal` (Task 3).
- Produces:
  - `api.getHost(): Promise<{ platform: string; canReveal: boolean }>`
  - `api.revealFiles(sessionId: string, paths: string[]): Promise<{ ok: true }>`
  - `useHost` store with `{ platform: string | null; canReveal: boolean; load(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/stores/host.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useHost } from './host';
import { api } from '../api/client';

describe('useHost', () => {
  beforeEach(() => {
    useHost.setState({ platform: null, canReveal: false });
    vi.restoreAllMocks();
  });

  it('loads the daemon capability', async () => {
    vi.spyOn(api, 'getHost').mockResolvedValue({ platform: 'darwin', canReveal: true });
    await useHost.getState().load();
    expect(useHost.getState()).toMatchObject({ platform: 'darwin', canReveal: true });
  });

  it('stays incapable when the probe fails — Reveal just never offers itself', async () => {
    vi.spyOn(api, 'getHost').mockRejectedValue(new Error('offline'));
    await useHost.getState().load();
    expect(useHost.getState().canReveal).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter dispatch-web test -- host`
Expected: FAIL — cannot resolve `./host`; `api.getHost` does not exist.

- [ ] **Step 3: Implement**

In `packages/web/src/api/client.ts`, add to the files block (right after `downloadUrl`):

```ts
  // Which capabilities does the daemon we're talking to have? `canReveal` is true only when
  // this browser is on the SAME machine as the daemon (see core files/reveal.ts).
  getHost: () => req<{ platform: string; canReveal: boolean }>(`/api/state/host`),
  revealFiles: (sessionId: string, paths: string[]) =>
    req<{ ok: true }>(`/api/sessions/${sessionId}/files/reveal`, { method: 'POST', body: body({ paths }) }),
```

Create `packages/web/src/stores/host.ts`:

```ts
import { create } from 'zustand';
import { api } from '../api/client';

interface HostState {
  platform: string | null;
  /** True only when the browser and the daemon are the same machine (and it's macOS). */
  canReveal: boolean;
  load: () => Promise<void>;
}

export const useHost = create<HostState>((set) => ({
  platform: null,
  canReveal: false,
  load: async () => {
    try {
      const h = await api.getHost();
      set({ platform: h.platform, canReveal: h.canReveal });
    } catch {
      // Probe failed — stay incapable. Reveal simply won't appear in the menu, which is the
      // correct degradation: never offer an action we can't confirm the daemon can perform.
    }
  },
}));
```

In `packages/web/src/App.tsx`, add the import alongside the other stores:

```ts
import { useHost } from './stores/host';
```

and add this line to the bootstrap effect, next to `void useUpdate.getState().load();` (line 64):

```ts
    void useHost.getState().load();
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dispatch-web test -- host`
Expected: PASS (2)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/stores/host.ts packages/web/src/stores/host.test.ts packages/web/src/App.tsx
git commit -m "feat(web): host capability store + reveal API client"
```

---

### Task 7: `ImageFileTab` — render image files as images

**Files:**
- Create: `packages/web/src/components/tabs/ImageFileTab.tsx`, `packages/web/src/components/tabs/ImageFileTab.test.tsx`
- Modify: `packages/web/src/components/tabs/TabHost.tsx:70`

**Interfaces:**
- Consumes: `isImage` (`lib/fileType.ts:14`), `api.imageUrl` (`client.ts:108`), `ChatImage` with the `maxHeight` prop from Task 4.
- Produces: `ImageFileTab({ terminal }: { terminal: Terminal })`

> **Why a separate component and not a branch inside `FileEditorTab`:** `FileEditorTab` fires
> `api.readFile()` in a `useEffect` (line 51), and that route is `utf-8` JSON — pulling a PNG
> through it yields mojibake. An early return inside the component can't prevent the hook from
> running, so the branch has to happen one level up, at the `TabHost` switch.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/components/tabs/ImageFileTab.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImageFileTab } from './ImageFileTab';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';

const terminal = {
  id: 't1',
  sessionId: 's1',
  type: 'file',
  label: 'logo.png',
  config: { path: 'assets/logo.png' },
} as unknown as Terminal;

describe('ImageFileTab', () => {
  it('renders the image from the byte route', () => {
    render(<ImageFileTab terminal={terminal} />);
    const img = screen.getAllByRole('img')[0] as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(api.imageUrl('s1', 'assets/logo.png'));
  });

  it('shows the file path in the header', () => {
    render(<ImageFileTab terminal={terminal} />);
    expect(screen.getByText('assets/logo.png')).toBeInTheDocument();
  });

  it('never pulls the binary through the utf-8 read route', () => {
    const readFile = vi.spyOn(api, 'readFile');
    render(<ImageFileTab terminal={terminal} />);
    expect(readFile).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter dispatch-web test -- ImageFileTab`
Expected: FAIL — cannot resolve `./ImageFileTab`

- [ ] **Step 3: Implement**

Create `packages/web/src/components/tabs/ImageFileTab.tsx`:

```tsx
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
```

In `packages/web/src/components/tabs/TabHost.tsx`, add the imports:

```ts
import { ImageFileTab } from './ImageFileTab';
import { isImage } from '../../lib/fileType';
```

and replace the `case 'file':` arm (line 70):

```tsx
      case 'file': {
        // Images can't go through the CodeMirror editor — /files/read is utf-8 JSON.
        const p = (tab.config?.path as string) || tab.label;
        return isImage(p) ? <ImageFileTab terminal={tab} /> : <FileEditorTab terminal={tab} />;
      }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dispatch-web test -- ImageFileTab TabHost`
Expected: PASS (3 new; existing TabHost tests unchanged)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/tabs/ImageFileTab.tsx packages/web/src/components/tabs/ImageFileTab.test.tsx packages/web/src/components/tabs/TabHost.tsx
git commit -m "feat(web): view image files inline instead of as mojibake"
```

---

### Task 8: `FilesPane` multi-select

**Files:**
- Modify: `packages/web/src/components/inspector/FilesPane.tsx`
- Test: `packages/web/src/components/inspector/FilesPane.test.tsx`

**Interfaces:**
- Produces (module-level, exported for test):
  - `sortEntries(a: FileEntry, b: FileEntry): number`
  - `flattenFiles(children: Record<string, FileEntry[]>, expanded: Set<string>, path?: string): string[]`
- Internal state: `selected: Set<string>` (file paths), `anchor: string | null`.

- [ ] **Step 1: Write the failing test**

Append to `packages/web/src/components/inspector/FilesPane.test.tsx` (keep the file's existing
mocks/imports; add `fireEvent` to the `@testing-library/react` import if absent):

```tsx
  it('cmd-click adds to the selection without opening the file', async () => {
    const createTerminal = vi.spyOn(api, 'createTerminal');
    render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
    const a = await screen.findByText('a.png');
    const b = await screen.findByText('b.png');

    fireEvent.click(a);                                  // plain click: selects AND opens
    createTerminal.mockClear();
    fireEvent.click(b, { metaKey: true });               // cmd-click: selects only

    expect(createTerminal).not.toHaveBeenCalled();

    // Both are now targets: right-click one, and Delete should offer to remove 2 items.
    fireEvent.contextMenu(b);
    expect(screen.getByText('Delete 2 items')).toBeInTheDocument();
  });

  it('shift-click selects the range between the anchor and the clicked row', async () => {
    render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
    const a = await screen.findByText('a.png');
    const c = await screen.findByText('c.txt');

    fireEvent.click(a);
    fireEvent.click(c, { shiftKey: true });

    fireEvent.contextMenu(c);
    expect(screen.getByText('Delete 3 items')).toBeInTheDocument(); // a.png, b.png, c.txt
  });

  it('right-clicking outside the selection collapses it to that row', async () => {
    render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
    const a = await screen.findByText('a.png');
    const b = await screen.findByText('b.png');
    const c = await screen.findByText('c.txt');

    fireEvent.click(a);
    fireEvent.click(b, { metaKey: true });
    fireEvent.contextMenu(c);                            // c is NOT selected

    expect(screen.getByText('Delete')).toBeInTheDocument();       // singular — just c
    expect(screen.queryByText(/Delete \d+ items/)).toBeNull();
  });
```

The existing test file's `api.listFiles` mock must return three entries so the range test has
something to span. Ensure the mock for `path: '.'` resolves to:

```ts
[
  { name: 'a.png', path: 'a.png', isDirectory: false },
  { name: 'b.png', path: 'b.png', isDirectory: false },
  { name: 'c.txt', path: 'c.txt', isDirectory: false },
]
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter dispatch-web test -- FilesPane`
Expected: FAIL — cmd-click still opens the file; "Delete 2 items" is not rendered.

- [ ] **Step 3: Implement**

In `packages/web/src/components/inspector/FilesPane.tsx`:

Add `useMemo` to the React import. Add module-level helpers below `parentDir`:

```ts
/** Directories first, then name — the single ordering both the tree and Shift-ranges use. */
export function sortEntries(a: FileEntry, b: FileEntry): number {
  return Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name);
}

/**
 * The visible FILE rows in render order. This is the coordinate space a Shift-click range spans:
 * it must walk the tree exactly as renderDir does (same sort, only into expanded directories),
 * or "select everything between these two rows" would select rows the user can't see.
 */
export function flattenFiles(
  children: Record<string, FileEntry[]>,
  expanded: Set<string>,
  path = '.',
): string[] {
  const out: string[] = [];
  for (const e of (children[path] ?? []).slice().sort(sortEntries)) {
    if (e.isDirectory) {
      if (expanded.has(e.path)) out.push(...flattenFiles(children, expanded, e.path));
    } else {
      out.push(e.path);
    }
  }
  return out;
}
```

Inside the component, add state next to `menu`:

```ts
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
```

Reset it wherever the tree resets — extend the existing effect at line 92:

```ts
  useEffect(() => {
    setChildren({}); setExpanded(new Set()); setSelected(new Set()); setAnchor(null);
    if (projectId) void loadDir('.');
  }, [projectId, loadDir]);
```

Add a path→entry index (so the menu can show names, not paths):

```ts
  const entryByPath = useMemo(() => {
    const m = new Map<string, FileEntry>();
    for (const list of Object.values(children)) for (const e of list) m.set(e.path, e);
    return m;
  }, [children]);
```

Add the two row handlers:

```ts
  /** Finder semantics: plain click opens; Cmd/Ctrl toggles; Shift ranges. */
  function onRowClick(ev: React.MouseEvent, entry: FileEntry) {
    if (ev.metaKey || ev.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      setAnchor(entry.path);
      return;
    }
    if (ev.shiftKey && anchor) {
      const flat = flattenFiles(children, expanded);
      const i = flat.indexOf(anchor);
      const j = flat.indexOf(entry.path);
      if (i >= 0 && j >= 0) {
        const [lo, hi] = i <= j ? [i, j] : [j, i];
        setSelected(new Set(flat.slice(lo, hi + 1)));
        return; // range-select does not open anything
      }
    }
    setSelected(new Set([entry.path]));
    setAnchor(entry.path);
    void openFile(entry);
  }

  /** Right-clicking inside the selection acts on all of it; outside it, collapse to that row. */
  function onRowContext(ev: React.MouseEvent, entry: FileEntry) {
    ev.preventDefault();
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      setAnchor(entry.path);
    }
    setMenu({ x: ev.clientX, y: ev.clientY, entry });
  }
```

Rewrite the file-row branch of `renderDir` (lines 168-177) to use them, and to show selection:

```tsx
      const isSel = selected.has(e.path);
      const isOpen = e.path === selectedPath;
      const { Icon: FIcon, color: fcolor } = fileVisual(e.name);
      return (
        <Row key={e.path}
          onClick={(ev) => onRowClick(ev, e)}
          onMiddle={() => void openFile(e, true)}
          onContext={(ev) => onRowContext(ev, e)}
          style={{ display: 'flex', alignItems: 'center', gap: 7, padding: `6px 8px 6px ${pl}px`, borderRadius: 5, color: isSel || isOpen ? '#e9e9ec' : '#a8a8b0', background: isSel ? '#33333c' : isOpen ? '#26262b' : undefined, cursor: 'pointer' }}>
          <FIcon size={15} weight="fill" color={isSel || isOpen ? '#e9e9ec' : fcolor} style={{ flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
        </Row>
      );
```

`Row`'s `onClick` must now forward the event. Change its signature and call:

```tsx
function Row({ children, style, onClick, onMiddle, onContext }: { children: React.ReactNode; style: React.CSSProperties; onClick: (e: React.MouseEvent) => void; onMiddle?: () => void; onContext?: (e: React.MouseEvent) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div onClick={onClick}
      onAuxClick={(e) => { if (e.button === 1 && onMiddle) { e.preventDefault(); onMiddle(); } }}
      onContextMenu={onContext}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...style, background: style.background ?? (hover ? 'rgba(255,255,255,0.04)' : 'transparent') }}>
      {children}
    </div>
  );
}
```

The directory `Row` at line 160 passes `onClick={() => toggle(e.path)}`, which still satisfies
the new signature (it just ignores the event) — no change needed there.

Finally, derive the menu's targets just above the `return` (Task 9 consumes this):

```ts
  // What the menu acts on: the whole selection if the right-clicked row is part of it,
  // otherwise just that row (onRowContext has already collapsed the selection to it).
  const targets: string[] = menu
    ? (selected.has(menu.entry.path) ? [...selected] : [menu.entry.path])
    : [];
```

Change the Delete menu item's label to reflect the count (full menu comes in Task 9):

```tsx
              <TrashSimple size={15} /> {targets.length > 1 ? `Delete ${targets.length} items` : 'Delete'}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dispatch-web test -- FilesPane`
Expected: PASS (existing 5 + 3 new = 8)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/inspector/FilesPane.tsx packages/web/src/components/inspector/FilesPane.test.tsx
git commit -m "feat(web): Finder-style multi-select in the Files pane"
```

---

### Task 9: Selection-aware context menu

**Files:**
- Modify: `packages/web/src/components/inspector/FilesPane.tsx`
- Test: `packages/web/src/components/inspector/FilesPane.test.tsx`

**Interfaces:**
- Consumes: `targets`, `entryByPath`, `selected` (Task 8); `saveFilesAs`/`RemoteFile` (Task 5);
  `copyImageToClipboard` (Task 4); `useHost` + `api.revealFiles` (Task 6); `isImage`
  (`lib/fileType.ts`); `api.imageUrl`, `api.downloadUrl`.

- [ ] **Step 1: Write the failing test**

Append to `packages/web/src/components/inspector/FilesPane.test.tsx`:

```tsx
  it('offers Copy Image for a lone image, and hides it for anything else', async () => {
    render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
    const a = await screen.findByText('a.png');
    const c = await screen.findByText('c.txt');

    fireEvent.contextMenu(a);
    expect(screen.getByText('Copy Image')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.contextMenu(c);                                  // a .txt is not an image
    expect(screen.queryByText('Copy Image')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.click(a);                                        // two images selected — still no
    fireEvent.click(await screen.findByText('b.png'), { metaKey: true });
    fireEvent.contextMenu(a);
    expect(screen.queryByText('Copy Image')).toBeNull();       // ClipboardItem can't hold two
  });

  it('copies the absolute paths of the whole selection as text', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<FilesPane projectId="p1" onOpenFile={() => {}} />);

    fireEvent.click(await screen.findByText('a.png'));
    fireEvent.click(await screen.findByText('c.txt'), { metaKey: true });
    fireEvent.contextMenu(await screen.findByText('c.txt'));
    fireEvent.click(screen.getByText('Copy 2 Paths'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/work/a.png\n/work/c.txt'));
    vi.unstubAllGlobals();
  });

  it('hides Reveal in Finder when the daemon is remote', async () => {
    useHost.setState({ platform: 'darwin', canReveal: false });
    render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
    fireEvent.contextMenu(await screen.findByText('a.png'));
    expect(screen.queryByText('Reveal in Finder')).toBeNull();
  });

  it('reveals the whole selection when the daemon is local', async () => {
    useHost.setState({ platform: 'darwin', canReveal: true });
    const reveal = vi.spyOn(api, 'revealFiles').mockResolvedValue({ ok: true } as never);
    render(<FilesPane projectId="p1" onOpenFile={() => {}} />);

    fireEvent.click(await screen.findByText('a.png'));
    fireEvent.click(await screen.findByText('b.png'), { metaKey: true });
    fireEvent.contextMenu(await screen.findByText('b.png'));
    fireEvent.click(screen.getByText('Reveal in Finder'));

    await waitFor(() => expect(reveal).toHaveBeenCalledWith('p1', ['a.png', 'b.png']));
  });

  it('hides Rename for a multi-selection', async () => {
    render(<FilesPane projectId="p1" onOpenFile={() => {}} />);
    fireEvent.click(await screen.findByText('a.png'));
    fireEvent.click(await screen.findByText('b.png'), { metaKey: true });
    fireEvent.contextMenu(await screen.findByText('b.png'));
    expect(screen.queryByText('Rename')).toBeNull();
  });

  it('deletes every selected file after one confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const del = vi.spyOn(api, 'deleteFile').mockResolvedValue({ ok: true } as never);
    render(<FilesPane projectId="p1" onOpenFile={() => {}} />);

    fireEvent.click(await screen.findByText('a.png'));
    fireEvent.click(await screen.findByText('b.png'), { metaKey: true });
    fireEvent.contextMenu(await screen.findByText('b.png'));
    fireEvent.click(screen.getByText('Delete 2 items'));

    await waitFor(() => expect(del).toHaveBeenCalledTimes(2));
    expect(window.confirm).toHaveBeenCalledTimes(1);      // one prompt, not two
  });
```

Add to that test file's imports:

```tsx
import { waitFor } from '@testing-library/react';
import { useHost } from '../../stores/host';
```

and ensure the `useProjects` mock supplies `workingDir: '/work'` for project `p1`, and that
`useHost` is reset in a `beforeEach`:

```tsx
beforeEach(() => { useHost.setState({ platform: 'darwin', canReveal: false }); });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter dispatch-web test -- FilesPane`
Expected: FAIL — "Copy Image", "Copy 2 Paths", "Reveal in Finder" don't exist; Delete only
removes one file.

- [ ] **Step 3: Implement**

In `packages/web/src/components/inspector/FilesPane.tsx`, extend the icon import and add the rest:

```ts
import { CaretRight, Copy, DownloadSimple, FolderOpen, ImageSquare, PencilSimple, TrashSimple } from '@phosphor-icons/react';
import { copyImageToClipboard } from '../../lib/clipboard';
import { isImage } from '../../lib/fileType';
import { useHost } from '../../stores/host';
```

Inside the component, read the capability:

```ts
  const canReveal = useHost((s) => s.canReveal);
```

Replace the single-entry `saveAs` / `deleteEntry` handlers with selection-aware ones, and add
the three new actions:

```ts
  function nameOf(p: string): string {
    return entryByPath.get(p)?.name ?? p.split('/').pop() ?? p;
  }

  async function saveTargets(paths: string[]) {
    if (!projectId) return;
    const files: RemoteFile[] = paths.map((p) => ({ url: api.downloadUrl(projectId, p), name: nameOf(p) }));
    try { await saveFilesAs(files); }
    catch (err: any) { window.alert(`Save failed: ${err?.message ?? err}`); }
  }

  // Only ever offered for a LONE image: ClipboardItem accepts one item, and only an image
  // MIME type actually pastes into an upload field. Multiple files is Reveal's job.
  async function copyImage(p: string) {
    if (!projectId) return;
    try { await copyImageToClipboard(api.imageUrl(projectId, p)); }
    catch { window.alert('Copy failed — the browser refused to put this image on the clipboard.'); }
  }

  async function copyPaths(paths: string[]) {
    const wd = project?.workingDir ?? '';
    const abs = paths.map((p) => (wd ? `${wd}/${p}` : p));
    try { await navigator.clipboard.writeText(abs.join('\n')); }
    catch { window.alert('Copy failed — the clipboard is unavailable.'); }
  }

  async function reveal(paths: string[]) {
    if (!projectId) return;
    try { await api.revealFiles(projectId, paths); }
    catch (err: any) { window.alert(`Reveal failed: ${err?.message ?? err}`); }
  }

  async function deleteTargets(paths: string[]) {
    if (!projectId) return;
    const label = paths.length === 1 ? `"${nameOf(paths[0])}"` : `${paths.length} items`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    const dirs = new Set(paths.map(parentDir));
    try {
      for (const p of paths) await api.deleteFile(projectId, p);
      setSelected(new Set());
      for (const d of dirs) await loadDir(d);
    } catch (err: any) { window.alert(`Delete failed: ${err?.message ?? err}`); }
  }
```

Derive what the selection can support, just below `targets`:

```ts
  // The lone image case is the ONLY one the browser clipboard can serve as a real file.
  const loneImage = targets.length === 1 && isImage(targets[0]) ? targets[0] : null;
```

Replace the whole menu body (currently the three buttons) with:

```tsx
          <div role="menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1000, minWidth: 190, padding: 4, background: 'var(--color-elevated, #26262b)', border: '1px solid #37373d', borderRadius: 8, boxShadow: '0 10px 30px -10px rgba(0,0,0,.7)' }}>
            <button type="button" onClick={() => { const t = targets; setMenu(null); void saveTargets(t); }}
              style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
              <DownloadSimple size={15} /> {targets.length > 1 ? `Save ${targets.length} Files As…` : 'Save As…'}
            </button>
            {loneImage && (
              <button type="button" onClick={() => { const p = loneImage; setMenu(null); void copyImage(p); }}
                style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
                <ImageSquare size={15} /> Copy Image
              </button>
            )}
            <button type="button" onClick={() => { const t = targets; setMenu(null); void copyPaths(t); }}
              style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
              <Copy size={15} /> {targets.length > 1 ? `Copy ${targets.length} Paths` : 'Copy Path'}
            </button>
            {canReveal && (
              <button type="button" onClick={() => { const t = targets; setMenu(null); void reveal(t); }}
                style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
                <FolderOpen size={15} /> Reveal in Finder
              </button>
            )}
            {targets.length === 1 && (
              <button type="button" onClick={() => { const entry = menu.entry; setMenu(null); void renameEntry(entry); }}
                style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
                <PencilSimple size={15} /> Rename
              </button>
            )}
            <div style={{ height: 1, background: '#37373d', margin: '4px 6px' }} />
            <button type="button" onClick={() => { const t = targets; setMenu(null); void deleteTargets(t); }}
              style={{ ...MENU_ITEM, color: '#f87171' }}>
              <TrashSimple size={15} /> {targets.length > 1 ? `Delete ${targets.length} items` : 'Delete'}
            </button>
          </div>
```

Delete the now-unused single-file `saveAs` and `deleteEntry` functions (lines 104-108 and
122-129 of the original file). Keep `renameEntry` as-is.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter dispatch-web test -- FilesPane`
Expected: PASS (8 + 6 new = 14)

- [ ] **Step 5: Full suite + typecheck**

```bash
pnpm --filter dispatch-server test
pnpm --filter dispatch-web test
pnpm --filter dispatch-server exec tsc --noEmit
pnpm --filter dispatch-web exec tsc -b --pretty false
```
Expected: all green, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/inspector/FilesPane.tsx packages/web/src/components/inspector/FilesPane.test.tsx
git commit -m "feat(web): selection-aware Files context menu (Reveal, Copy Image, Copy Paths)"
```

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| `GET /api/state/host` with `canReveal` from `req.socket.remoteAddress` | 1, 2 |
| `POST /files/reveal`, loopback re-enforced, `resolveSafe`, `execFile` arg array, all paths | 1, 3 |
| `.avif`/`.bmp` added to `IMAGE_MIME` | 3 |
| Image preview via `ChatImage` + `api.imageUrl`, no `readFile` | 7 |
| Multi-select: click / ⌘-click / Shift-click; right-click in vs. out of selection | 8 |
| Menu: Save As (1 + N), Copy Image (lone image), Copy Paths, Reveal (gated), Rename (single), Delete (N, one confirm) | 9 |
| Lift `fetchAsPngBlob` into a shared lib | 4 |
| `stores/host.ts` fetched at bootstrap | 6 |
| Error handling: AbortError silent, picker fallback, clipboard failure surfaced | 4, 5, 9 |

No gaps.

**Type consistency** — `targets: string[]`, `entryByPath: Map<string, FileEntry>`,
`RemoteFile { url, name }`, `canReveal(addr, platform?)`, `revealInFinder(absPaths)`,
`saveFilesAs(files)`, `copyImageToClipboard(src)`, `flattenFiles(children, expanded, path?)`,
`sortEntries(a, b)`. Names are used identically in every task that references them.

**Out of scope (from the spec)** — multi-file clipboard of arbitrary types (impossible),
directory rows in multi-select, server-side zip, drag-out-of-browser.
