# Previews ("Inbox" in the app)

A thread hands you commands to run, links, files to look at and text to copy. The thread's
`preview` tool (one call: `kind`, `paths`, `text`, `title`, `note`, and the kind's own fields)
stores an item; you see a badge on the project and thread headers on the phone and on the Inbox
item in the desktop rail, open the sheet or the history, and the files open in the viewer.
The name the user reads is one constant, `NAME` in `web.js` (and the labels in `plugin.json`). HTML runs sandboxed. A thread posts into its own
project only, and every file is checked when it is posted and again when it is served.

Bundled with Dispatch and enabled by default. Disable it in Settings → Plugins; threads then lose
the tool at their next start.

Send a secret goes the other way: the owner sends a thread an API key by a 6-character ID (Inbox → Send a
secret), and the thread's `inbox_secret` tool has the daemon write it to a project file or to Doppler. The
value is kept by the daemon (`/api/plugins/previews/secrets`, `<data dir>/inbox-secrets`), not in this plugin's storage.

- `mcp/server.mjs`: the tools (`preview`, `inbox_secret`), a standalone MCP server that runs under the thread's key.
- `mcp/kinds.mjs`: the kinds and the checks of the tool's arguments.
- `web.js`: the sheet, the history, the badges, the menu rows.
- `instructions.md`: what the model is told about the tool.
