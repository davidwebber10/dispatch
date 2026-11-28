# Changelog

## 1.3.0

Dispatch 4.15.0. The Inbox is compact, so several items fit on a phone screen.

Two views, with a toggle in the top row: **Rows** (the default), one line for each item with one action
(copy, open the link, or open the pictures), and **Cards**, a short card with two lines of the note and a
small look at the content. A tap opens an item in place, with all of its content and Delete. One item is
open at a time. The Inbox remembers your view, also on your other devices. The project's sheet and the
thread's tab use the same view.

The title and the description at the top are gone. The search, Filters, the view toggle and Send Secret
are on one row. The old tall card is gone.

The search is behind a magnifying glass. Cancel, or Escape in the field, closes it and clears the text.
The key button is now **Send Secret** with a paper plane.

## 1.2.1

The Inbox follows the text scale (Settings → Appearance): its font sizes are in `rem`, so they grow and
shrink with the rest of the app. Nothing changes at 100%.

## 1.2.0

**Send a secret**: the other direction. In the Inbox (the view, a thread's tab, a project's sheet) the owner
sends a thread a secret (a name and a value) and gets a 6-character ID. The thread calls the new tool
`inbox_secret` with the ID, and Dispatch writes the value to a file of the project (a `NAME=value` line, or
the whole file, mode 0600) or to Doppler. The value never enters the chat; the thread reads it only when the
owner turned on "Let the thread read it". One use; an unused secret is gone after 24 hours. The value lives in
the daemon (`<data dir>/inbox-secrets`), never in the plugin's documents.

## 1.1.0

Previews is now named **Drops** in the app (the plugin id, the stored data and the `preview` tool keep
their names). The tool takes a `kind`: `command` (each command with its own Copy), `link`, `code`,
`secret` (masked; its text is removed after 24 hours), `steps`, `diff` and `table`. Every card carries a
chip with the kind's icon and color. Pictures open on the cached small copy, then a 1600 pixel copy,
with an Original button; the daemon serves a snapshot of each file taken when it was posted.

## 1.0.0

Previews moves out of the Dispatch core into this bundled plugin. Old previews are migrated once at
the daemon's first start with the plugin.
