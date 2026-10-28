# Security notes

Dispatch runs shells and AI agents on your computer with your full rights. This page says
what that means for you.

## One daemon per person

Dispatch has one owner per daemon. It has no user accounts and no per-person permissions.

- The access token (`dispatch access`) gives a shell on the computer as the account that runs
  the daemon, and read access to every secret the daemon holds.
- Do not share one daemon, or its token, between people. Each person runs their own daemon.
- To stop a device, run `dispatch access rotate`. It signs out every device at once.
- For how requests are accepted from other devices, see [network-access.md](network-access.md).

## Agents run with your rights

- Agent threads (Claude Code, Codex and the other providers) start with approval prompts turned
  off. A thread can run commands, edit files and use the tools and connectors you set up.
- Anything an agent reads can try to steer it: web pages, pull requests, files, and the output
  of other threads. Keep that in mind before you point a thread at content you do not trust.
- Every program on the computer that runs Dispatch can call the daemon. Agents are such programs.

## Limits you can change

These limits stop a runaway agent or a client bug. Normal use does not reach them. Each one reads an
environment variable when the daemon starts; set it in the daemon's environment.

| What | Default | Setting |
| --- | --- | --- |
| JSON request body | 1 MiB | `DISPATCH_MAX_JSON_BYTES` |
| JSON request body on the routes that carry big payloads (agent hook events, thread messages with images, Chat messages, file save, icons) | 50 MiB | `DISPATCH_MAX_LARGE_JSON_BYTES` |
| One WebSocket message from a client | 1 MiB (8 MiB on the terminal socket, where a paste is one message) | `DISPATCH_WS_MAX_PAYLOAD`, `DISPATCH_WS_TERMINAL_MAX_PAYLOAD` |
| Live threads (a running process) in one project | 60 (0 = no cap) | `DISPATCH_MAX_LIVE_THREADS` |
| Shortest gap between runs of a recurring schedule | 1 minute (0 = no minimum) | `DISPATCH_MIN_SCHEDULE_MINUTES` |
| Folders outside a project that a link inside it may lead to | none | `DISPATCH_FILE_ROOTS` (a `:`-separated list; `/` allows any) |

The file routes follow symbolic links, so a link inside a project that stays inside the project
works as before, and so do dependency links from one `node_modules` folder into another (a package inside a pnpm workspace). A link that leads outside the project is refused unless its target is under a
folder in `DISPATCH_FILE_ROOTS`.

## Secrets

- The Settings page lists the names of your Doppler secrets. A value is read one at a time,
  when you click reveal or copy.
- Keep literal secret values out of integration settings. Use a `${NAME}` reference to a secret
  instead, so the value stays out of command lines and config files.

## Images and links in Markdown

- A remote image in a reply does not load by itself. The page shows a "Load image" control with
  the image host, and loads the image only after you click it.
- The app sends a Content Security Policy: scripts only from the app, no framing by other
  sites, and connections only to the app itself.

## Updates

`dispatch update` and the in-app Update button install the latest release tag. Between
releases, `main` can hold unreleased changes, and updates never take them.

## Usage statistics

Dispatch sends anonymous counts and a random install ID about every 6 hours. Turn it off in
Settings or with `DISPATCH_TELEMETRY=0`.
