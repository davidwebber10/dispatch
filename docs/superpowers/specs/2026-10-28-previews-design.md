# Previews: a model shows the user a file or a string

Date: 2026-10-28. Status: approved in chat (the owner described the feature; the calls below
marked "my call" are the builder's).

## Intent

A thread (any agent, in terminal mode or Pretty mode) often has something to show the user
that words carry badly: a screenshot, a rendered page, a PDF, a chart, an HTML artifact, or a
string the user must copy (a URL, a command, a token). Today `post_image` shows one image
inline, and only in Pretty mode. In terminal mode the user cannot select text, so they switch
to Pretty mode to copy a line. On a phone this is the main way of working.

Previews gives every thread one tool to hand the user things to look at or copy, and gives the
user one place to find them: a **Previews** key next to **esc** above the phone's terminal
composer, a **Previews** button in the phone's thread header, and a **Previews** view in the
desktop left rail with the full history and its context.

## Goals

- A thread calls one tool with any mix of files and a text string. The user sees it on the
  phone within a second, in terminal mode as much as in Pretty mode.
- Images open in the app's lightbox. Text, Markdown, CSV and JSON open in the app with Copy.
  PDF and HTML open in a new tab in the browser's own viewer.
- A copyable string shows in a popover with one Copy button and select-all.
- History: everything a model has sent, newest first, with the project, the thread and the
  time, on desktop and on the phone.
- Desktop works well too: the rail view and the same sheet from the thread header.

## Non-goals

- Editing or annotating a preview.
- Previews from Chat (the endless coordinator). Chat renders its own images; it has no
  project folder. Can come later through the same table.
- Serving HTML with access to the app. An HTML preview runs in a sandbox with no cookie and no
  app origin; it cannot call the API.
- Push notifications for a new preview. The in-app badge is enough for this slice.

## Anti-goals

- Never make an arbitrary-file read: paths stay inside the project folder, symlinks are
  resolved, and only known extensions are served.
- Never let a thread post into another project (the existing key scope rules).
- Never break `post_image`: it keeps returning the inline image block.

## The tool

`preview` (new, in the agency MCP every thread gets):

```
preview({ title?: string, note?: string, text?: string, paths?: string[] })
```

- `paths`: files inside the project working directory (relative or absolute). Allowed:
  png, jpg, jpeg, gif, webp, svg, pdf, html, htm, md, markdown, txt, csv, json. Up to 20
  files, 50 MB each. The daemon checks existence, extension and the real root.
- `text`: a string for the user to copy (any length up to 64 KB).
- `title`: a short name (default: the first file name, or "Text"). `note`: one line of context.
- At least one of `text` or `paths` is required.
- Returns `{ ok: true, id, url }` where `url` is the daemon's address for the preview.

`post_image` (existing) keeps its behaviour and **also** posts the image as a preview, so a
terminal-mode thread's screenshots reach the user. If the preview post fails, the inline image
still returns (best effort; my call).

The role policy's allowed-tool list gains `preview`.

## Daemon

- Table `previews`: `id, session_id, session_name, terminal_id, terminal_label, title, note,
  text, files (JSON [{ path, name, mime, size }]), created_at, seen_at`. Names are snapshots at
  post time so the history reads right after a rename or an archive.
- `POST /api/sessions/:id/previews`: a thread key may post to its own project (same rule as
  reading its project); the owner may post too. Validates as above. Broadcasts
  `preview:new { preview }`.
- `GET /api/previews?limit=200`: every project, newest first (owner only).
- `GET /api/sessions/:id/previews`: one project (owner only).
- `POST /api/previews/:id/seen`, `DELETE /api/previews/:id` (owner only). Both broadcast
  `preview:changed { id, sessionId, seenAt | deleted }`.
- `GET /api/previews/:id/files/:k`: the bytes of file k (owner only). Content type from the
  extension. HTML is served with `Content-Security-Policy: sandbox allow-scripts allow-popups
  allow-forms allow-modals` so it runs with an opaque origin: no cookies, no app API.

## Web

- Store `usePreviews`: items, per-project and global unseen counts, `applyEvent` for the two
  events, `load`, `markSeen`, `remove`.
- Shared `PreviewItem`: title, context line (project · thread · time), note, the text block
  with Copy, file chips. Tapping an image chip opens `ImageLightbox`; md/txt/csv/json open an
  in-app overlay with the content and Copy; pdf/html open in a new tab.
- `PreviewSheet`: the project's previews, newest first, in the app's `Sheet`. Marks items seen
  when it opens.
- Phone: a **Previews** soft key to the LEFT of **esc** in the terminal row (badge with the
  project's unseen count); a **Previews** button in the thread header (level 2) for both
  terminal and Pretty threads. Both open `PreviewSheet`.
- Desktop: a **Previews** entry in the left rail (badge: global unseen) that opens
  `PreviewsView`: the full history across projects, grouped by day, each with its context and a
  Delete. The thread header's existing controls are untouched (my call: the rail view covers
  desktop; a header button there is a later nicety).

## Constraints

- Keep the app's CSP. Images are same-origin (`img-src 'self'`), text comes through the API.
- Opening a PDF or HTML from the phone's home-screen app opens Safari. Accepted.
- One daemon, one table; no sync between devices beyond the daemon.

## Build order

1. Daemon: table, db module, router, tests.
2. MCP: `preview` tool, `post_image` hook, role list, tests.
3. Web: types, client, store, item, sheet, phone key and header button, rail view, tests.
4. Release note; the daemon needs a rebuild and restart.
