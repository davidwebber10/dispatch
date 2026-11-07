# Previews

A thread hands you files to look at and text to copy. The thread's `preview` tool (one call:
`paths`, `text`, `title`, `note`) stores a preview; you see a badge on the project and thread
headers on the phone and on the Previews item in the desktop rail, open the sheet or the
history, and the files open in the viewer. HTML runs sandboxed. A thread posts into its own
project only, and every file is checked when it is posted and again when it is served.

Bundled with Dispatch and enabled by default. Disable it in Settings → Plugins; threads then lose
the tool at their next start.

- `mcp/server.mjs`: the tool, a standalone MCP server that runs under the thread's key.
- `web.js`: the sheet, the history, the badges, the menu rows.
- `instructions.md`: what the model is told about the tool.
