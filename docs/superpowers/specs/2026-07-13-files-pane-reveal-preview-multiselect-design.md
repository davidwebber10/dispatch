# Files Pane: Reveal in Finder, Image Preview, Multi-Select

**Date:** 2026-07-13
**Status:** Approved

## Purpose

Three additions to the Files pane, driven by one underlying need: getting assets that an
agent produced — often on a *remote* headless Mac mini — out of Dispatch and into wherever
the user needs them (a chat upload field, Finder, another app).

1. **Reveal in Finder** on right-click, when the browser and the daemon are the same machine.
2. **Image preview** — clicking an image file shows the raw image instead of mojibake.
3. **Multi-select** with a selection-aware right-click menu (Save As, Copy, Delete, Reveal).

## The Constraint That Shapes Everything

The original request was "select multiple files, right-click Copy, paste into an upload field."
**A web page cannot do this.** Three independent walls:

1. `navigator.clipboard.write()` only accepts a narrow MIME allowlist for real cross-app
   pasting — in practice `image/png` and text. PDFs, zips, `.jpg` cannot be written as files.
   Chrome's "web custom formats" exist but a paste target sees them as opaque blobs.
2. Chrome throws on more than one `ClipboardItem`:
   *"Support for multiple ClipboardItems is not implemented."* Multi-file clipboard does not exist.
3. `<input type="file">` does not accept paste at all. Sites that appear to (Claude, Slack,
   Gmail) run a `paste` handler reading `clipboardData.files`, which the browser populates
   only for images — **or for files copied natively in Finder.**

That last clause is the design's hinge. **Finder's ⌘C pastes into upload fields; a web page's
cannot.** So the feature is not "make the browser copy files" — it is "hand the job to the one
process on the machine that is allowed to do it."

This produces two coherent paths:

- **Local daemon** (files are on the Mac you are sitting at) → Reveal in Finder, multi-selected,
  then Finder's own ⌘C or drag. Any file type, any count.
- **Remote daemon** (files are on the mini) → the bytes must physically reach your Mac before a
  local upload field can accept them. Reveal is meaningless there — it would open Finder on a
  headless box. The remote path is **Save As** to a folder you pick.
- **Either way**, the one thing the browser *can* do: **Copy Image** on a single image → PNG on
  the clipboard → pastes into Claude/Slack/Gmail. This covers the generated-image case.

Every verb in the menu does what it can genuinely do. Nothing pretends.

## What Already Exists (unwired)

Exploration found three pieces already built and never connected:

- `isImage()` — `packages/web/src/lib/fileType.ts:14`. Exported, **zero callers** repo-wide.
- `api.imageUrl()` + `GET /api/sessions/:id/files/image` — streams raw image bytes inline with a
  MIME allowlist, `nosniff`, and `Content-Security-Policy: sandbox`. Used **only by chat**.
- `ChatImage` — `packages/web/src/components/ChatImage.tsx:130`. A deliberately dumb, `src`-only
  renderer with a fullscreen lightbox, pinch-zoom, download, and a working
  `fetchAsPngBlob()` → `navigator.clipboard.write()` copy.

So image preview is largely a wiring job, and Copy Image is a reuse, not a build.

## Design

### Server — `packages/core`

**`GET /api/state/host`** → `{ platform, canReveal }`

`canReveal` is true only when the daemon runs on macOS **and the request arrived over loopback**.

Loopback is determined from **`req.socket.remoteAddress`**, never `req.ip`. `req.ip` honors
`X-Forwarded-For` when `trust proxy` is enabled, so a remote client could forge it to claim it is
local. The socket peer address cannot be forged.

Loopback set: `127.0.0.1`, `::1`, `::ffff:127.0.0.1`.

**`POST /api/sessions/:id/files/reveal`** — body `{ paths: string[] }`

- Re-enforces the loopback check **server-side**. The probe above is only a UI affordance; the
  endpoint never trusts the client.
- 403 if not loopback. 400 if not macOS. 400 on empty `paths`.
- Every path goes through the existing strict `resolveSafe` working-dir sandbox.
- Executes:

  ```ts
  execFile('open', ['-R', ...resolvedPaths], { timeout: 3000 })
  ```

  An **argument array, never a shell string** — a file named `$(rm -rf ~).png` is just a filename.
  Mirrors the established pattern in `routes/git.ts:15`.

Passing *all* selected paths is load-bearing: `open -R` with multiple files reveals them
**already multi-selected in Finder**, which is precisely what enables the native multi-file copy.

**Fix:** add `.avif` and `.bmp` to `IMAGE_MIME` (`routes/files.ts:99`). Today `isImage()` accepts
them but the server 415s, so the UI would show a broken image for files it claims are images.

### Web — `packages/web`

**Image preview.** `FileEditorTab` gains an early branch: when `isImage(path)`, render
`<ChatImage src={api.imageUrl(sessionId, path)} />` and **skip the `readFile` fetch entirely** —
binary must never be pulled through the `utf-8` JSON route. Lightbox, zoom, download and copy come
for free.

**Multi-select in `FilesPane`.** Finder semantics:

- Plain click — opens the file (existing behavior, unchanged) and collapses the selection to it.
- ⌘/Ctrl-click — toggles membership, does **not** open.
- Shift-click — selects the range within the flattened visible list, does **not** open.
- Right-click **inside** the selection acts on the whole selection.
- Right-click **outside** it collapses the selection to that row first.

Selection covers file rows only; directory rows are unchanged in this iteration.

**Selection-aware context menu.** Each verb appears only where it can actually work:

| Item | Shown when | Behavior |
|---|---|---|
| Save As… | any selection | 1 file → existing `showSaveFilePicker`. N files → **one** `showDirectoryPicker()`, writing each file into it. Fallback (Safari/iOS): N anchor downloads. |
| Copy Image | exactly one image | `fetchAsPngBlob()` → `navigator.clipboard.write()`. The honest limit of `ClipboardItem`. |
| Copy Path / Copy N Paths | any selection | Absolute paths, newline-joined, as `text/plain`. |
| Reveal in Finder | `canReveal` only | `POST .../files/reveal` with every selected path. |
| Rename | single only | Existing behavior. |
| Delete | any selection | One confirmation for N items. |

**Refactor.** Lift `fetchAsPngBlob()` out of `ChatImage` into a shared `lib/` module so the Files
pane and chat share one implementation instead of two.

**State.** A small `stores/host.ts` holding `{ platform, canReveal }`, fetched once at bootstrap —
same shape as the existing update store.

## Error Handling

- Reveal on a non-loopback client: the menu item is absent; if called anyway, 403.
- `showDirectoryPicker` / `showSaveFilePicker` `AbortError` (user cancelled): silent no-op.
- Picker unavailable (Safari, Firefox, iOS): fall back to anchor downloads, no error surfaced.
- Clipboard write rejected (permissions, non-secure context): surface a failure, do not fail silently.
- Delete/rename failures: existing `window.alert` path.

## Testing

**Core**
- `/reveal` returns 403 for a non-loopback socket address, and is not fooled by a forged
  `X-Forwarded-For`.
- `/reveal` rejects path traversal.
- `/reveal` invokes `execFile` with an argument array (no shell), containing every resolved path.
- `/image` serves `.avif` and `.bmp` rather than 415.
- `GET /api/state/host` reports `canReveal` correctly for loopback vs remote.

**Web**
- ⌘-click toggles; Shift-click ranges.
- Menu items appear/hide correctly per selection (Copy Image only for a lone image; Rename only
  for a single file; Reveal only when `canReveal`).
- Multi Save As drives a mocked `showDirectoryPicker` and writes every file.
- Copy Image writes a PNG `ClipboardItem`.
- Copy Paths writes newline-joined absolute paths.
- Delete N asks once and deletes all.
- `FileEditorTab` renders `ChatImage` for an image path and **does not** call `readFile`.

## Out of Scope

- Multi-file clipboard copy of arbitrary types — impossible in a browser (see Constraint).
- Directory rows in multi-select.
- Server-side zip of a selection — rejected in favor of the folder picker (no new dependency,
  no temp-file lifecycle, lands as files rather than an archive).
- Drag-out-of-browser (`DownloadURL`) — Chromium-only and single-file; Reveal covers the case.
