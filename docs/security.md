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
