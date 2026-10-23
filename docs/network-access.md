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

1. On the computer that runs Dispatch, run `dispatch access`. It prints the access token.
2. Open Dispatch on the other device. It shows a sign-in page.
3. Paste the token. The browser keeps a cookie for 400 days.

`dispatch access --link HOST` (a port in HOST is kept as given; or `--link https://MACHINE.ts.net` for `tailscale serve`) prints a link for a phone: the token is in the part after `#`, which
browsers never send to a server.

`dispatch access rotate` makes a new token and signs out every device.

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
