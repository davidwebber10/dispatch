# Bundled plugins

Plugins that ship with Dispatch (docs/superpowers/specs/2026-11-07-plugins-design.md, section 10).
The daemon serves each folder here in place: a bundled plugin updates with Dispatch, can be
disabled on Settings → Plugins, cannot be removed, and is not edited here. "Copy to local" on
that page duplicates one under a new id in `~/.dispatch/plugins` for the owner to change.
A local plugin with the same id as a bundled one hides it.

Each folder is a complete plugin: `plugin.json`, `web.js`, `README.md`, `CHANGELOG.md`, and
whatever the manifest names (`instructions.md`, `mcp/`, `hooks/`). See `docs/plugins.md`.
