# Network access

Dispatch runs shells and agents as you, so it must not answer just anyone. This page says
who can use it, how to sign in another device, and how to use the API from a script.

## Who gets in without signing in

| Caller | Signs in? |
|---|---|
| A browser, agent, hook or `dispatch` command on the computer that runs Dispatch | No |
| Your own devices on Tailscale (same Tailscale account), direct or through `tailscale serve` | No |
| Windows browser at `localhost` when Dispatch runs in WSL2 | No |
| Any other device (another laptop on the same Wi-Fi, a coworker on a shared tailnet, a public tunnel) | Yes, once per browser |

A request from this computer is trusted only when the `Host` header also names this computer
(`localhost`, a `127.x` address, `::1`, the machine's own Tailscale name, or a name you added).
A web page cannot make your browser send those names while it talks to another site, so a
page you visit cannot drive Dispatch. Requests from a foreign `Origin`, WebSockets included,
are refused.

## Sign in another device

A device that must sign in sees a splash page: the Dispatch mark, two steps, and an **Enter a
code** button. There are two ways through it.

**With a sign-in code (a phone):**

1. On a device that is already signed in, open **Settings → Devices & access** and tap **Make a code**.
   You get a code like `ABCD-EFGH` and a QR code. The code works once and lasts 5 minutes.
2. Scan the QR code with the phone's camera and open the link. The phone signs in and the app
   opens. Or open Dispatch on the phone, tap **Enter a code**, and type the code.

If you opened Settings on the computer itself (`localhost`, `127.0.0.1` or `::1`), a phone
cannot use that address: on a phone, `localhost` means the phone. Dispatch then fills the field
with an address for this computer that a phone can reach, with the same scheme and port. It
prefers the Tailscale address when Tailscale is up, and otherwise the Wi-Fi (LAN) address, and a
note says so. On WSL2 it offers only a Tailscale address that `tailscaled` inside WSL holds: a Tailscale on the Windows side does not forward Dispatch's port, so type an address yourself there. If it finds none, the field keeps the page address and the note asks you to type
one. An address you type always wins, and a saved `localhost` address is ignored.

The QR code carries the address in the **Address the phone will use** field plus the code,
as `ADDRESS/#code=ABCD-EFGH`. Browsers never send the part after `#` to a server. Set the
field to the address the phone can reach (a tunnel hostname or a Tailscale name). The daemon
keeps one live code at a time; a new code replaces the old one. The token itself is never
sent to the browser.

**With the token:**

1. On the computer that runs Dispatch, run `dispatch access`. It prints the access token.
   (The command refuses to run inside a Dispatch thread. If `dispatch` is not on your `PATH`,
   run `./bin/dispatch access` from the repository folder.)
2. Open Dispatch on the other device, tap **Enter a code**, and paste the token.

Either way the browser keeps a cookie for 400 days, and it shows up as a device (next section).

`dispatch access --link HOST` (a port in HOST is kept as given; or `--link https://MACHINE.ts.net` for `tailscale serve`) prints a link for a phone: the token is in the part after `#`, which
browsers never send to a server.

`dispatch access rotate` makes a new token and signs out every device at once.

## Signed-in devices

Every browser or phone that signs in, by code, QR code or token, becomes a device. **Settings →
Access → Signed-in devices** lists them. Each row has a name taken from the browser (you can
rename it), how it signed in, the address it last used, when it was first seen and when it was
last active. The row for the browser you are using is marked **This device**.

**Revoke** on a row signs out that one device and no other. The device's open connections close
at once, and it sees the sign-in page on its next request. **Sign out this device** on your own
row signs you out here. Only the owner can list or revoke: an agent thread key gets `403` on
these routes. A browser on the computer itself, or on your own Tailscale, needs no sign-in and
has no row.

How it works: the cookie names the device and carries a signature that depends on the access
token. Dispatch accepts the cookie only while the token is the same and the device row exists.
So `dispatch access rotate` still signs out every device (and clears the list), and a revoke
deletes one row. The database holds no cookie secret.

**Upgrading does not sign anyone out.** Before the device list, every browser held the same
cookie. After the update, that cookie still works. The first time each phone or browser opens
Dispatch, Dispatch makes a device for it ("Signed in before the device list") and hands it its
own cookie in the reply. From then on you can revoke it on its own. Two browsers that open
Dispatch within 10 seconds, with the same browser name and address, may share one row until the
next sign-in. A device that never opens Dispatch again never gets a row, and the old shared
cookie cannot be told apart from it. Once your devices have appeared, press **Sign out devices
not in this list** to turn the old shared cookie off. Anything still holding it then has to
sign in again. `dispatch access rotate` also turns it off.

**Addresses.** The address is the one the connection came from. Behind `tailscale serve` it is
the tailnet client that `serve` reports. A request from this computer shows as **This computer**.
On WSL2 in the default (NAT) mode, a Windows browser at `localhost` arrives from the Windows host,
shown as **Windows host (WSL)**. A phone that reaches Dispatch through a Windows `netsh portproxy`
rule shows the same label, because Dispatch cannot tell the two apart (see the WSL note below).
An address marked **(via proxy)** is what a proxy on this computer reported (`tailscale serve` reports the tailnet client). Dispatch cannot check it, and a client behind a portproxy can set it, so treat it as a hint. It never grants access. "This device" never uses the address: it uses the cookie, so it stays right in every setup. In
WSL2 mirrored mode a Windows browser at `localhost` arrives as `127.0.0.1` and shows as **This
computer**; a LAN device shows its own address.

Devices on your own Tailscale need no sign-in, so they do not appear in this list. Manage or remove
them in the Tailscale admin console. To list a phone here, open the Wi-Fi (LAN) address instead of
the Tailscale address.

Up to 100 devices are kept. The least recently active ones drop off first.

## Scripts and other tools

Send the token as `Authorization: Bearer TOKEN`. Do not type the token on a command line: other
processes, and endpoint agents, can read command lines. Read it from the file instead:

```bash
printf 'Authorization: Bearer %s\n' "$(cat ~/.dispatch/access-token)" > /tmp/dispatch-header
chmod 600 /tmp/dispatch-header
curl -H @/tmp/dispatch-header http://MACHINE:3456/api/sessions
```

## Behind a proxy or tunnel

A proxy on this computer (Cloudflare Tunnel or similar) reaches Dispatch over loopback, but with
its own public name in `Host`. If the proxy adds forwarding headers (`X-Forwarded-For` and similar) Dispatch
ignores a `localhost` Host and still asks for sign-in. A proxy that adds none (a plain nginx
`proxy_pass`, `socat`, `ssh -R`) looks like a local caller, so do not put such a proxy in front of
Dispatch without its own sign-in. That name is not known, so people get the sign-in page. Either
sign in once per browser, or run `dispatch access allow-host YOUR.HOSTNAME`. Only add a name
whose proxy has its own sign-in: Dispatch then trusts it like `localhost`. `tailscale funnel`
(public internet) always gets the sign-in page.

`dispatch access list-hosts` and `dispatch access remove-host NAME` manage the list
(`~/.dispatch/access.json`).

## Cloudflare Access verification

`allow-host` trusts a name. A name is not proof: any program on this computer can send that
`Host` header to the daemon, and a tunnel with no Access policy sends it for every visitor. When
Cloudflare Access protects the name, Dispatch can check the proof that Cloudflare adds.

After its own sign-in, Cloudflare Access adds a header to each request, `Cf-Access-Jwt-Assertion`.
It is a signed token (a JWT) for your team and for one Access application.

The check is **off** by default. An install that does not turn it on behaves exactly as before.

Turn it on:

```bash
dispatch access cloudflare --team-domain YOUR-TEAM.cloudflareaccess.com --aud YOUR-AUD-TAG
```

- The team domain is in the Zero Trust dashboard: Settings, Custom Pages (or the address of your
  Access sign-in page).
- The aud tag is on the Access application: Overview, "Application Audience (AUD) Tag".
- Neither value is a secret. The daemon reads the change with no restart.

With the check on:

- A request to an allow-listed host counts as "this computer" **only** when it carries a valid
  assertion: signed by your team's key (RS256), for your aud tag, from your team domain, and not
  expired. The clock tolerance is 60 seconds.
- A request to an allow-listed host with a missing or invalid assertion gets the normal sign-in
  (the sign-in page, or `401` on `/api`). It is never a hard refusal. The access token and a
  signed-in device cookie still work.
- `localhost` on this computer, Tailscale and the sign-in page do not change.
- Dispatch reads the team's public keys from
  `https://YOUR-TEAM.cloudflareaccess.com/cdn-cgi/access/certs` and keeps them in memory. A key
  that it does not know causes one new read, at most once per 60 seconds. If the keys cannot be
  read and none is in memory, the request gets the sign-in page and the daemon logs one line per
  minute.

Other commands:

```bash
dispatch access cloudflare          # print the state
dispatch access cloudflare --off    # trust an allow-listed host by its name alone again
dispatch status                     # prints "Cloudflare Access check: on (team ...)" or "off"
```

When a host is allow-listed and the check is off, `dispatch status` prints one line of advice.

Limits:

- The check proves that the request passed your Access policy. It does not replace that policy.
- The values are in `~/.dispatch/access.json` (`cloudflareAccess`). If you edit the file by hand
  and a value is not valid, the check stays on and no allow-listed host passes it. Run the command
  again to repair it.
- A program on this computer that runs as you can read the access token (see "What this does not
  cover"). The check does not change that.

## Thread keys

Every agent thread that Dispatch starts gets its own key. The key lives in the environment of
that one process (`DISPATCH_AUTH`) and in no log, database or command line. Dispatch makes a new
key each time it starts the process, and it ends the key when the process ends. A restart of
Dispatch ends all keys, and the threads that come back get new ones.

- **Owner-only actions.** A call with a thread key to an action that only you may do gets
  `403 owner_only`. Examples are changing a thread's settings or role. The message names the
  method and the route (for example, `GET /api/integrations/export`) and says that the refusal
  covers only that route: a thread key may still do other things, such as add or list
  integrations. Your browser, the `dispatch` CLI and your own scripts are not affected.
- **Calls with no credential: most still work, four kinds do not.** From this computer a call with
  no credential is allowed and counted, except for these actions, which answer `401 auth_required`:
  1. a message or terminal input as you (a thread message, raw terminal input, a file reference
     typed into a terminal, a Chat message, the Chat instructions), including typing over a terminal
     WebSocket (a credential-free script may still attach and watch, but its input is dropped);
  2. answering a thread's held tool call, or setting a thread to autonomous (which releases them);
  3. starting a thread (creating a tab, branching a thread, starting a queued thread, creating a project's coordinator) or
     replacing a thread's config, which includes its queued task (a label-only rename stays open);
  4. changing, deleting or importing integrations.

  These pass when the call comes from the Dispatch web page (a browser always sends an `Origin`
  header), carries your access token, or carries a thread's own key that the action allows.
  The browser, the `dispatch` CLI, `dispatch api` and the agent tools need no change. A script or
  `curl` must send `Authorization: Bearer TOKEN` (`dispatch access` shows the token; keep it out of
  the command line, for example with `curl -H @FILE`).
  **Still works with no credential, by design:** all reads (the coordinator `GET` only looks and
  answers 404 when there is none), hooks, the browser shim, adding an integration, renaming,
  stopping, restarting or relaunching a tab, and the ledger routes. Starting a thread from a project with no tab (`POST /api/sessions/ID/relaunch`) is refused, but a
  project that has a tab restarts it.

  **Accepted exceptions that can run chosen content.** These stay open to a credential-free caller
  on purpose, and each can end in a thread that runs something the caller chose:
  - *Schedules.* Creating a schedule, editing its prompt and `run-now` (`/api/agents/schedules`)
    need no credential, and the daemon launches the schedule's prompt as a thread task. This is an
    arbitrary-task execution path. Role runs (the files you wrote) start inside the daemon.
  - *Restart, relaunch and restore of an existing tab.* They ignore a task or config in the request,
    but they reload what is on disk and in settings. Project file writes (`/api/sessions/ID/files`)
    stay open, a restart reloads the provider's own config, and integrations that were added (adding
    one stays open) go into the next spawn's config. So a restart or a restore does not guarantee that
    only content you approved runs.

  Closing these needs the same proof on those routes; the owner chose not to, to keep scripts and
  normal use working.
- **This is a drift check, not a lock.** A program that sets an `Origin` header by hand passes it,
  and any program running as you can read the token file (see below). The check stops the
  ordinary case: a plain `curl` that an injected agent runs, or an old script. It does not stop a
  program that works around it on purpose.
- **See the counts** with `dispatch status`. The refusals also log one rate-limited line,
  `[keys] refused keyless caller METHOD ROUTE`.
||||||| 778d03a0
  `403`. Examples are changing a thread's settings or role. Your browser, the `dispatch` CLI and
  your own scripts are not affected.
- **Calls with no credential still work in this release.** From this computer they are allowed
  as before, and Dispatch counts them. A later release will refuse them.
- **See the counts** with `dispatch status`. A count that stays at zero means nothing relies on
  the old behavior.
- **Scripts.** `dispatch api METHOD PATH` makes one call to the daemon on this computer with the
  right credential. The token never appears in the command line. To send a body, use
  `--body FILE` or `--body -` for standard input. For example:
  `dispatch api GET /api/sessions`.
- **Overseers.** The overseer of a project can read the threads of every project. It can also
  message the overseer of another project, at most 10 messages per hour to the same overseer.
  Each such message starts with a sender line that names the sending project and thread. An
  overseer cannot start, archive, answer or spawn in another project. Other threads cannot reach
  across projects at all.
- **Chat and workers are unchanged.** Chat turns and worker threads keep working as before,
  inside their own project.

## Files

`~/.dispatch` is mode `0700` and the database, `access-token` and `access.json` are `0600`, so
other accounts on the same computer cannot read them.

## What this does not cover

- Sign-in tries are counted per client; behind a proxy that hides the client address, one visitor's
  failed tries can delay another sign-in for a minute.
- A proxy on this computer that adds no forwarding headers, or a raw TCP forwarder, is treated as
  local. Give it its own sign-in, or do not use it.
- Anything running as your own user can read the token file. Agents run as you.
- Other accounts on the same computer can still reach Dispatch over loopback.
- WSL2 with a `netsh interface portproxy` rule to the LAN: that traffic arrives like the Windows
  host and is not protected. Remove the rule and use Tailscale.

See `docs/superpowers/specs/2026-10-22-network-exposure-design.md` for the full design.
