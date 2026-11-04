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

1. On a device that is already signed in, open **Settings → Access** and tap **Make a code**.
   You get a code like `ABCD-EFGH` and a QR code. The code works once and lasts 5 minutes.
2. Scan the QR code with the phone's camera and open the link. The phone signs in and the app
   opens. Or open Dispatch on the phone, tap **Enter a code**, and type the code.

If you opened Settings on the computer itself (`localhost`, `127.0.0.1` or `::1`), a phone
cannot use that address: on a phone, `localhost` means the phone. Dispatch then fills the field
with an address for this computer that a phone can reach, with the same scheme and port. It
prefers the Tailscale address when Tailscale is up, and otherwise the Wi-Fi (LAN) address, and a
note says so. If it finds none, the field keeps the page address and the note asks you to type
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

## Thread keys

Every agent thread that Dispatch starts gets its own key. The key lives in the environment of
that one process (`DISPATCH_AUTH`) and in no log, database or command line. Dispatch makes a new
key each time it starts the process, and it ends the key when the process ends. A restart of
Dispatch ends all keys, and the threads that come back get new ones.

- **Owner-only actions.** A call with a thread key to an action that only you may do gets
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
