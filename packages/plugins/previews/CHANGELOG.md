# Changelog

## 1.1.0

Previews is now named **Drops** in the app (the plugin id, the stored data and the `preview` tool keep
their names). The tool takes a `kind`: `command` (each command with its own Copy), `link`, `code`,
`secret` (masked; its text is removed after 24 hours), `steps`, `diff` and `table`. Every card carries a
chip with the kind's icon and color. Pictures open on the cached small copy, then a 1600 pixel copy,
with an Original button; the daemon serves a snapshot of each file taken when it was posted.

## 1.0.0

Previews moves out of the Dispatch core into this bundled plugin. Old previews are migrated once at
the daemon's first start with the plugin.
