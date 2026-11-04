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

## What stopping a thread ends

Stopping, archiving or relaunching a thread ends the agent program that Dispatch started. Dispatch asks it to
quit, and if it is still running 3 seconds later, Dispatch kills it. A shell tab ends the same way.

Dispatch does not hunt down the programs that the agent started. A server that an agent started on
purpose to keep running (with `nohup`, `setsid` or by detaching it from the shell) can keep running after
the thread is gone. This is accepted. Such a program looks the same as one you want to keep, such as a dev
server. To end one, find it with `lsof -i :PORT` or `ps`, and stop it yourself.

## Limits you can change

These limits stop a runaway agent or a client bug. Normal use does not reach them. Each one reads an
environment variable when the daemon starts; set it in the daemon's environment.

| What | Default | Setting |
| --- | --- | --- |
| JSON request body | 1 MiB | `DISPATCH_MAX_JSON_BYTES` |
| JSON request body on the routes that carry big payloads (agent hook events, thread messages with images, Chat messages, file save, icons) | 50 MiB | `DISPATCH_MAX_LARGE_JSON_BYTES` |
| One WebSocket message from a client | 1 MiB (8 MiB on the terminal socket, where a paste is one message) | `DISPATCH_WS_MAX_PAYLOAD`, `DISPATCH_WS_TERMINAL_MAX_PAYLOAD` |
| Live threads (a running process) in one project | 60 (0 = no cap) | `DISPATCH_MAX_LIVE_THREADS` |
| Stored push subscriptions (one per phone or browser) | 50 (0 = no cap) | `DISPATCH_MAX_PUSH_SUBSCRIPTIONS` |
| Live watches over all threads (one thread may hold 20) | 500 (0 = no cap) | `DISPATCH_MAX_WATCHES` |
| One line of an agent run's output held in memory | 32 MiB (0 = no cap) | `DISPATCH_MAX_STREAM_LINE_BYTES` |
| Unread data on a WebSocket client before it is checked (it is dropped only if the queue stops shrinking between checks, or passes 4 times this size at once; a long chat history is sent in step with the free space, so it loads on a slow link; the browser reconnects) | 32 MiB (0 = no cap) | `DISPATCH_WS_MAX_BUFFERED_BYTES`, `DISPATCH_WS_BUFFER_GRACE_MS` (10 s between checks) |
| Uncaught errors in one minute before the daemon exits to be restarted (below this it logs and stays up) | 10 (0 = never exit) | `DISPATCH_MAX_UNCAUGHT_PER_MINUTE` |
| Error reports written to the log per minute for one kind (unhandled rejections; uncaught exceptions when the exit limit is 0); the rest are counted in one line | 20 (0 = log all) | `DISPATCH_MAX_CRASH_LOGS_PER_MINUTE` |
| Shortest gap between runs of a recurring schedule | 1 minute (0 = no minimum) | `DISPATCH_MIN_SCHEDULE_MINUTES` |
| Folders outside a project that a link inside it may lead to | none | `DISPATCH_FILE_ROOTS` (a `:`-separated list; `/` allows any) |

These limits are a partial fix for stability (SEC-23). Still open: a line-size cap for Chat threads (the run-stream cap covers agent runs only), and a cap on how many threads one thread can start (the owner has not decided this one).

The file routes follow symbolic links, so a link inside a project that stays inside the project
works as before, and so do dependency links from one `node_modules` folder into another (a package inside a pnpm workspace). A link that leads outside the project is refused unless its target is under a
folder in `DISPATCH_FILE_ROOTS`.

## Secrets

- The Settings page lists the names of your Doppler secrets. A value is read one at a time,
  when you click reveal or copy.
- Keep literal secret values out of integration settings. Use a `${NAME}` reference to a secret
  instead, so the value stays out of command lines and config files.

## Phone notifications

A phone or browser can subscribe to notifications only through the push service of its browser
maker: Apple, Google (FCM), Mozilla or Microsoft (WNS). Dispatch refuses any other address, so
it cannot be made to send your thread and project names to a server you do not know.

Settings > Access lists every device that receives notifications: its browser and system, the
push service host, when it was added and when Dispatch last sent it an alert. Revoke stops
alerts to that one device. The list never shows the full push address. Only the owner can list
or revoke (a thread key gets 403).

## If the daemon hits an error nothing caught

Dispatch logs the error with its stack and keeps running. An exit would end every live agent
thread. If more than 10 such errors happen in one minute, it exits so launchd (macOS) restarts a
clean daemon. The WSL scheduled task does not restart a daemon, so on WSL start it again by hand.

## Who made an integration or a schedule

Agents may add integrations, enable roles and create schedules. Dispatch does not block this.
A thread that sends its own key may do all three, and Dispatch records the thread by name. A
role run, a shell and Chat cannot, so a scheduled run cannot add the next schedule.
Settings shows "Added by" on each integration, and the Agents screen shows "Created by" on
each schedule (a role's schedule shows who enabled the role). A row from before the record
existed shows "Unknown". A call with no key and no sign-in shows as "Local, no sign-in",
because a browser on this Mac without an access token looks the same as a call that skips
its key.

## Images and links in Markdown

- A remote image in a reply does not load by itself. The page shows a "Load image" control with
  the image host, and loads the image only after you click it.
- The app sends a Content Security Policy: scripts only from the app, no framing by other
  sites, and connections only to the app itself.
- The Browser tab opens only `http`, `https` and `about:blank` addresses. A stored `javascript:`,
  `data:` or `vbscript:` address is replaced with a blank page. The image download fallback never
  follows a `javascript:` address. These checks work in every browser, with or without the policy above.

## Updates

`dispatch update` and the in-app Update button install the latest release tag. Between
releases, `main` can hold unreleased changes, and updates never take them.

## Usage statistics

Dispatch sends anonymous counts and a random install ID about every 6 hours. Turn it off in
Settings or with `DISPATCH_TELEMETRY=0`.
