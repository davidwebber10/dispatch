---
title: Network exposure fix (issue 94)
date: 2026-10-22
status: approved by the owner on 2026-10-23; Phase 1 under build
base: origin/main 5c7ce554 (v3.3.1)
issue: 94
---

# Network exposure fix (issue 94)

## 1. Summary

**Severity: critical.** The local daemon accepts connections on every network
interface and has no request authentication. Anyone who can reach the port gets
everything the owner has: they can drive threads, open a terminal (a shell as the
user) and read any file. A port scan of a coffee shop, airport or hotel network is
enough to find it. A malicious web page in the owner's own browser can also drive
it, through a WebSocket that the daemon accepts from any origin (section 4.3).

The fix ships in two phases.

- **Phase 1 (ship within one or two days):** a request gate. A request with no
  credential is served only when it comes from this machine (or from the owner's
  own Tailscale devices) **and** names a known host. Every other request needs the
  access token, or a cookie that the token unlocks. Browser requests from a foreign
  origin are refused, WebSocket upgrades included. No change to the listen address,
  no firewall rules, no per-OS code paths beyond the existing WSL rule.
- **Phase 2 (full design):** paired devices (QR code or short code instead of the
  raw token), a Network and devices settings page, an exposure warning in
  onboarding and the app, and a choice of listen address with "this computer
  only" as the default for new installs.

Tailscale is the main remote-access case. No current user is known to put
Cloudflare or another tunnel in front of Dispatch, so the design does not build
around that case (section 6.6 has a short note).

## 2. Who can reach the daemon today

The daemon calls `server.listen(preferredPort)` with no host
(`packages/core/src/server.ts:818`), so it listens on `*:3456` (IPv4 and IPv6). A
test daemon on port 3480 showed `TCP *:3480 (LISTEN)` plus the two loopback guards
(`server.ts:825`, `platform/loopback-guard.ts`).

Plain reachability, with no change to anyone's setup:

| Who | Can they connect? |
|---|---|
| Programs on the same machine | Yes. |
| Devices on the same Wi-Fi or LAN (coffee shop, airport, hotel, office guest network) | **Yes**, unless the network isolates clients from each other or a host firewall blocks the port. Do not count on either: the macOS application firewall is off by default, and many networks do not isolate clients. |
| The public internet | **Only if** the machine has a public IPv4 address, a router port forward, or a global IPv6 address on a network that does not filter inbound IPv6. Most home routers block inbound IPv6. Some campus, hotel and mobile networks do not. |
| A web page open in the owner's browser | **Yes** for WebSockets (no Origin check). Plain `fetch` reads are blocked by the browser's same-origin rule, but DNS rebinding gets around that rule because the daemon does not check the `Host` header. |
| Tailscale peers | Yes, for every device the tailnet ACL allows (not only the owner's devices). |
| Through a reverse proxy or tunnel on the machine (Cloudflare or similar) | Whoever the proxy lets through. No current user is known to run one. |
| A WSL2 daemon, NAT mode (the default) | LAN devices: no, unless the owner added a Windows `netsh portproxy` rule and a firewall rule. The Windows host browser: yes, through `localhostForwarding`. |
| A WSL2 daemon, mirrored mode | LAN devices: only if the Hyper-V firewall allows inbound traffic (probably blocked by default, not verified). The Windows host browser: yes, through shared loopback. |

WSL2 users are therefore less exposed to the LAN than macOS users by default, but
the web page attacks (section 4.1) hit every platform the same way.

Checks made for this spec on the test daemon (port 3480, `HOME=/tmp/dispatch-net-home`,
stopped afterwards):

- `GET http://192.168.x.y:3480/api/sessions` from the machine's own Wi-Fi address: `200`.
- `GET /api/sessions` with `Host: evil.example:3480` on loopback: `200` (no Host check).
- WebSocket upgrade to `/api/events` with `Origin: http://evil.example`: `101 Switching Protocols`.

## 3. Inventory: every way the daemon is reached

### 3.1 Browser (web app and PWA)

- The web app is same-origin and uses relative paths only. `apiPath()` and `wsUrl()`
  build every URL from `document.baseURI` and `location`
  (`packages/web/src/lib/basePath.ts:19-37`). No client code sends an auth header or
  sets `credentials`. A same-origin `HttpOnly` cookie is therefore sent on every
  fetch, WebSocket, `img`, download anchor and navigation with no client change.
- One fetch wrapper, `req()` (`packages/web/src/api/client.ts:26-41`), plus raw
  fetches for uploads, transcription, update apply, image copy and downloads
  (`client.ts:258,275,356`, `ChatImage.tsx:39`, `lib/clipboard.ts:31`,
  `lib/saveFiles.ts:34,67`).
- Three WebSockets, all through `wsUrl()`: `/api/events`
  (`api/events-socket.ts:18-40`, reconnects forever with a 5 s cap),
  `/api/terminals/:id/ws` (`api/terminal-socket.ts:70,101`) and
  `/api/terminals/:id/structured-ws` (`api/structured-socket.ts:27,31`).
- URLs loaded with no script control (cookie or nothing): images from
  `api.imageUrl` and `endlessMediaUrl` (`client.ts:235,67`), Markdown images,
  download anchors (`lib/saveFiles.ts:8-15`).
- Shell poll: `fetch('/')` every 90 s and on focus (`packages/web/src/main.tsx:40-50`).
- Service worker `packages/web/public/sw.js`: skips `/api`, caches the shell only
  when `res.ok && !res.redirected` (`sw.js:46-87`), makes no background calls to the
  daemon. Push uses `/api/push/key`, `/api/push/subscribe`, `/api/push/presence`
  through `req()`. Push works only in a secure context (HTTPS).
- Server switcher: `DISPATCH_SERVERS` and `/api/servers`
  (`packages/core/src/routes/servers.ts`); `BrandSwitcher.tsx:16-25` does a full
  page navigation to the other origin, so each daemon is its own origin.
- No EventSource or SSE anywhere.
- Dev only: Vite proxies `/api` to the daemon with `changeOrigin: true`
  (`packages/web/vite.config.ts:13-15`), so the daemon sees `Host: localhost:3456`
  and `Origin: http://localhost:5173`.

### 3.2 Programs on the same machine

None of these sends a credential today. All of them connect over loopback.

| Caller | Where | URL |
|---|---|---|
| `dispatch status` probe | `packages/cli/src/index.ts:106-115` | `http://localhost:PORT/api/sessions` |
| `dispatch roles` | `packages/cli/src/index.ts:254-259` | `http://localhost:PORT/api/roles` |
| Claude Code status hooks | `providers/claude-code.ts:134-138`, written at `sessions/service.ts:361-366` | `http://127.0.0.1:PORT/api/events/claude/ID` |
| Codex notify helper | `providers/codex.ts:59-65`, `core/scripts/codex-notify.mjs:10-27` | `http://127.0.0.1:PORT/api/events/codex/ID` |
| Grok hook | `providers/grok-home.ts:91-93`, `core/scripts/grok-hook.mjs:14-35` | `http://127.0.0.1:PORT/api/events/grok/ID` |
| Browser shim (`dispatch-open`) | `auth/shim.ts:112-118`, installed at `server.ts:441-444` | `http://127.0.0.1:PORT/api/auth-requests` |
| Agency MCP (`dispatch` tools in threads) | `overseer/agency-mcp.ts:45-47`, `overseer/agency-shared.ts:65-70`, env at `sessions/service.ts:2853-2866` | `http://localhost:PORT` |
| Endless Chat memory MCP | `endless/memory-mcp.ts:16-18`, env at `endless/service.ts:160` | `http://localhost:PORT` |

The other CLI commands (`install`, `restart`, `update`, `logs`, `release`) never call
the daemon over HTTP. `dispatch update` runs `git pull`, a build and
`daemon.restart()` (`packages/cli/src/index.ts:321-347`); the web app polls
`/api/update/progress` and reconnects after the restart. `POST /api/update/apply`
spawns `bin/dispatch update` detached (`update/apply.ts:130-139`).

### 3.3 Proxies in front of the daemon

Tailscale is the main remote-access path for current users.

- **Tailscale direct.** The README's recommended path is
  `http://MACHINE.TAILNET.ts.net:3456` (`README.md:76-79`, `docs/cloudflare.md:126-132`),
  and the setup wizard's Mobile step shows a QR code of
  `http://DNSNAME:PORT` (`packages/core/src/setup/detect.ts:241-243`,
  `packages/web/src/components/setup/SetupWizard.tsx:126-160`). The peer address is
  the phone's tailnet address, not loopback. **This path depends on the
  all-interfaces listen.**
- **`tailscale serve`** (HTTPS, needed for the iPhone PWA and push). A loopback
  peer (`docs/wsl2-bring-up.md:128-141`) with the machine's `ts.net` name as `Host`.
- **Other reverse proxies or tunnels** (Cloudflare Tunnel is documented in
  `docs/cloudflare.md`). Also a loopback peer, with the proxy's public name as
  `Host`. No current user is known to use one.
- **Hosted box.** A private-subnet router injects `x-dispatch-box-token`;
  `requireBoxToken` and `upgradeAllowed` enforce it (`server.ts:463-464,765`,
  `auth/box-token.ts`). Unset locally, so a no-op there.

### 3.4 Existing "is this client local" rule

`platform.isLocalClient` already exists for the Reveal action:

- macOS and Linux: no proxy header, loopback socket peer, loopback `Host`
  (`platform/darwin.ts:60`, helpers in `files/reveal.ts:14-78`).
- WSL: also accepts the Windows host's NAT gateway address as the peer
  (`platform/wsl.ts:98-102`). The July real-hardware pass confirmed that a Windows
  host browser reaches a WSL daemon through `localhostForwarding` **from the
  gateway address, not loopback** (`docs/wsl2-bring-up.md`, Tier-3 run log).

The helpers read `req.socket.remoteAddress` (set by the kernel), never `req.ip`.
The gate reuses them.

### 3.5 What an unauthenticated caller can do

Everything. Examples: `POST /api/terminals/:terminalId/input` and `/message`
(`routes/terminals.ts:322,137`), the terminal WebSocket, `GET
/api/sessions/:id/files/read?path=` with any absolute path (`routes/files.ts:95-96,195`),
`PUT /files/write` and `POST /files/upload` (`files.ts:333,350`), secrets and
integrations settings, `POST /api/update/apply`. `POST
/api/auth-requests/:id/callback` makes the daemon fetch any loopback URL on any port
(`auth/service.ts:89-101`), which is a request-forgery path into other local
services. The gate closes all of these at once.

## 4. Threat model

### 4.1 In scope

1. **LAN attacker.** Any device on the same network. Can send any bytes, any
   headers, any `Host`. Cannot send packets that arrive on the loopback interface,
   and cannot complete a TCP handshake from a forged source address it cannot
   receive replies on.
2. **Malicious web page in the owner's browser**, three ways:
   - **Cross-site WebSocket.** Browsers do not apply CORS to WebSockets. A page on
     any site can open `ws://localhost:3456/api/events`, read `terminal:status`
     events that carry terminal IDs (`status/service.ts:56,419`), then open
     `/api/terminals/ID/ws` and type into a shell. Verified server side: the
     upgrade returns `101` for `Origin: http://evil.example`. **This is a remote
     takeover through a web page today, on every OS, with no LAN attacker.**
   - **CSRF.** A cross-site form or `fetch` with `mode: no-cors` reaches the
     handler. The page cannot read the response, but state-changing routes run.
   - **DNS rebinding.** A page on `evil.example` rebinds its name to `127.0.0.1`.
     The browser now treats the daemon as same-origin with the page and lets it
     read responses. Only a `Host` check stops this.
   Chrome's and Firefox's Local Network Access prompts reduce the browser cases
   in those browsers only (section 6.7). Safari and Firefox do not have it. The daemon must not
   depend on it.
3. **Public-internet attacker**, for machines with a public IP, port forward or
   unfiltered IPv6. Same capability as the LAN attacker.
4. **Tunnel exposure.** `tailscale funnel` (or any public tunnel) puts
   loopback-looking requests from the internet in front of the daemon.

### 4.2 Out of scope (documented limits)

- **Processes running as the same OS user.** They can read `~/.dispatch` (and the
  access token) and run anything the daemon can. No network fix changes that.
- **Other OS users on the same machine.** Phase 1 trusts loopback, so another
  local user can still drive the daemon. Phase 2 offers an opt-in "require a
  credential on loopback too" mode (section 8.7). Shared multi-user machines are
  rare for this tool.
- **The tunnel's own gate.** Tailscale ACLs (and the sign-in of any other proxy)
  are the owner's configuration.

### 4.3 The trust question for tunnels

`tailscale serve` (and any other same-machine proxy) connects over loopback, so
**a loopback peer address alone does not prove the request is local**.
The design never trusts the peer address alone. A credential-free request also
needs a known `Host` header:

- A LAN attacker cannot reach loopback at all, whatever `Host` it sends.
- A rebinding page cannot make the browser send a known `Host` (`localhost`, this
  machine's `ts.net` name) while the browser is connected to the attacker's name.
- A request through another proxy carries a name the daemon does not know, so it
  gets the sign-in page unless the owner adds the name (section 6.6).
- A `tailscale serve` request also carries `Tailscale-User-Login`, which
  `tailscale serve` sets for tailnet requests and does not set for Funnel requests
  (section 6.5). Phase 1 trusts the `ts.net` host only when that header is present,
  so Funnel traffic gets the sign-in page.

## 5. Options compared

| Option | Stops LAN | Stops web page (WS, CSRF, rebinding) | Breaks | Size |
|---|---|---|---|---|
| A. Per-machine firewall rule | Yes, on the machines that install it | No | Nothing | Per OS, per machine. Users who "do nothing" stay exposed. Rejected by the requirements. |
| B. Listen on loopback only by default | Yes | No | Tailscale direct (the README path and the wizard QR), plain LAN, `tailscaled` inside WSL, hosted box. The WSL host browser should keep working (6.1) but is untested. | Small, but a breaking default and no help against web pages |
| C. Gate: credential for any request that is not local, plus Host and Origin checks | Yes | Yes | Plain LAN and Tailscale direct (each needs the token once per browser) | Small to medium. Same code on every OS. |
| D. C plus Tailscale owner check (`tailscale whois`) | Yes | Yes | Plain LAN | C plus one small module |
| E. D plus loopback listen as the default | Yes, and the port is not even visible | Yes | As B | D plus listener rework |

**Recommendation: D in Phase 1, E as an opt-in in Phase 2 and the default for new
installs that choose "this computer only".**

Reasons:

- The listen address alone (B) does not stop the web-page attacks, and those are as
  serious as the LAN attack. A gate with Host and Origin checks is required in
  every option that is not a firewall.
- With the gate in place, the listen address becomes defence in depth, not the
  control. Phase 1 can then leave the listen address alone, which keeps Tailscale
  direct, the hosted box and the WSL host browser working with no new risk from a
  listener change.
- The Tailscale owner check (D) keeps the documented phone path working with zero
  steps. Without it, every phone user over Tailscale must type a long token.
- Binding to the Tailscale address instead of all interfaces is **not** a safe
  boundary. Linux (and therefore WSL) accepts a packet for any local address on
  any interface, and Tailscale's Linux firewall rules filter on source, not
  destination. A LAN attacker can send to the victim's Ethernet address with the
  tailnet IP as the destination. macOS probably behaves the same way (not
  verified). Kernels drop packets for loopback addresses that arrive on a real
  interface, so loopback is the only address the design trusts without a
  credential or a Tailscale identity.

## 6. Platform and tunnel facts

### 6.1 WSL2

Sources: Microsoft Learn
[WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking) and
[wsl-config](https://learn.microsoft.com/en-us/windows/wsl/wsl-config), the WSL
source file
[`src/linux/init/localhost.cpp`](https://github.com/microsoft/WSL/blob/master/src/linux/init/localhost.cpp),
and the
[Hyper-V firewall](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/hyper-v-firewall)
page.

**NAT mode (the default).**

- `localhostForwarding` (default `true`): "ports bound to wildcard or localhost in
  the WSL 2 VM should be connectable from the host via `localhost:port`". So a
  daemon that listens on `127.0.0.1` inside WSL is still reachable from the
  Windows browser at `localhost`. The WSL source agrees: the relay finds every
  listening socket whatever its address, and connects to loopback inside the VM.
- The July real-hardware pass saw the Windows browser arrive **from the NAT
  gateway address** with today's all-interfaces listen. The existing WSL rule
  (`wsl.ts:98-102`) exists for this. Phase 1 keeps it.
- LAN devices cannot reach a WSL daemon by default: "This isn't the default case in
  WSL 2 ... you will need to go through the same steps as you would for a regular
  virtual machine" (a `netsh interface portproxy` rule plus a firewall rule). A
  portproxy connects to the VM's own address, so a daemon that listens on
  `127.0.0.1` only cannot be reached through it (inferred from the doc's note that
  remote access needs a `0.0.0.0` listen).
- Known WSL bugs: a relay on `::1` can hang so that `localhost` never falls back to
  IPv4 ([microsoft/WSL#41860](https://github.com/microsoft/WSL/issues/41860), open;
  [#5439](https://github.com/microsoft/WSL/issues/5439), older). A loopback-only
  listen on WSL should therefore use `127.0.0.1` only, not `::1` (Phase 2).

**Mirrored mode** (`networkingMode=mirrored`, Windows 11 22H2 and later).

- "the Windows host and WSL2 VM can connect to each other using `localhost`
  (127.0.0.1)". `localhostForwarding` is ignored. `::1` is not supported.
- LAN access to WSL is a listed feature of mirrored mode, behind the Hyper-V
  firewall. The docs tell users to set the inbound action to Allow, and the
  cmdlet's default is Block, so the LAN is probably blocked by default. Not
  verified for the WSL default; the WSL test (10.3) checks it.
- A Windows browser at `localhost` should arrive from `127.0.0.1` (inferred from
  the shared loopback).

**Tailscale with WSL.** Tailscale
[recommends Tailscale on the Windows host only](https://tailscale.com/docs/install/windows/wsl2),
not inside WSL. Traffic to the Windows host's tailnet address does not reach a NAT
mode WSL daemon without a portproxy. The working setups are `tailscale serve` on
Windows pointing at `localhost:PORT` (through the WSL relay, so the daemon sees the
gateway or loopback peer and the `ts.net` Host), or `tailscaled` inside WSL (the
daemon sees the phone's tailnet address).

**What this means for the design.**

- The gate runs inside WSL and needs no Windows change.
- Phase 1 treats the gateway peer like a loopback peer (same known-host rule). The
  only WSL users still at risk after Phase 1 are those who added a portproxy to
  the LAN on purpose: a LAN attacker can come through it from the gateway address
  and send a known `Host`. See residual R-2 (section 7.12).
- Phase 2 offers a `127.0.0.1` listen on WSL after the WSL test confirms the
  Windows browser still connects. That closes R-2 and removes the need for the
  gateway rule.

### 6.2 macOS

The macOS application firewall is off by default and cannot limit a port to
loopback and Tailscale. The `pf` rule in the issue works but is per machine and
needs an administrator. The gate makes it unnecessary.

### 6.3 Linux (non-WSL)

The daemon starts on Linux, but `dispatch install` and `restart` are not
implemented there (`platform/linux.ts:11-15`). The gate is OS-neutral, so Linux gets
it with no extra work.

### 6.4 Windows

There is no native Windows daemon. Windows means WSL2 started by a logon scheduled
task (`platform/daemon-wsl.ts:109-121`).

### 6.5 Tailscale

- [`tailscale serve`](https://tailscale.com/docs/reference/tailscale-cli/serve)
  proxies to `http://127.0.0.1` only, so the daemon sees a loopback peer. The
  source (`ipn/ipnlocal/serve.go`) keeps the original `Host` (the `ts.net` name) and
  sets `X-Forwarded-Proto: https`, `X-Forwarded-Host` and `X-Forwarded-For`.
- [Identity headers](https://tailscale.com/kb/1312/serve): `Tailscale-User-Login`,
  `Tailscale-User-Name`, `Tailscale-User-Profile-Pic`. "Funnel traffic, which is
  publicly available, does not include identity headers." They are also absent for
  tagged devices. Serve removes copies sent by the client, "to avoid header
  spoofing". The same page warns that a service that also listens on other
  addresses can receive forged copies directly. The gate honours the header only
  from a loopback (or WSL gateway) peer, so a LAN attacker cannot use it.
- Funnel requests also carry `Tailscale-Funnel-Request: ?1` (source only).
- `tailscale whois` and `tailscale status --json` give the owner of a peer address
  and of this machine. The daemon already runs `tailscale status --json`
  (`setup/detect.ts:232-245`, `platform/darwin.ts:62-75`, `platform/wsl.ts:103-113`).

### 6.6 Other reverse proxies and tunnels (not designed for)

No current user is known to run Cloudflare Tunnel or another proxy in front of
Dispatch. The design does not build anything for that case. A user who does will
see the sign-in page, because the proxy's public name is not a known host. They
have two ways in: sign in once per browser with the token, or run
`dispatch access allow-host NAME` once. The proxy's own sign-in (for example
Cloudflare Access) stays their gate, as today. `docs/cloudflare.md` gets one
paragraph that says this.

### 6.7 Browser protections against web pages

- Chrome shows a Local Network Access prompt for a public page that calls loopback
  or a private address from Chrome 142, and for WebSockets from Chrome 147
  ([LNA blog](https://developer.chrome.com/blog/local-network-access),
  [Chrome 147 notes](https://developer.chrome.com/release-notes/147)).
- Firefox turned on Local Network Access by default in 153 and extended it to
  WebSockets in 154
  ([153](https://www.firefox.com/en-US/firefox/153.0/releasenotes/),
  [154](https://www.firefox.com/en-US/firefox/154.0/releasenotes/)).
  Whether this covers WebSockets to loopback is not stated.
- No equivalent was found for Safari.
- A user can click Allow once, older versions do not have the prompt, and DNS
  rebinding makes the page look local. The daemon keeps its own Host and Origin
  checks.

## 7. Phase 1 design: the request gate

### 7.1 Rule

For every HTTP request and every WebSocket upgrade, after the base-path strip and
the existing box-token check, the gate decides in this order:

1. **Credential.** If the request carries a valid credential, it passes the
   trust step. Credentials:
   - `Authorization: Bearer TOKEN` where TOKEN is the access token (CLI scripts,
     other tools).
   - The `dispatch_access` cookie (browsers, after sign-in).
   - A valid `x-dispatch-box-token` when `DISPATCH_BOX_TOKEN` is set (hosted box,
     unchanged).
2. **Local and known host.** No credential is needed when both are true:
   - The socket peer (`req.socket.remoteAddress`) is loopback, **or** on WSL it is
     the Windows host's NAT gateway (the existing `wsl.ts:98-102` rule).
   - The `Host` header names a known host (section 7.3). The WSL gateway peer uses
     the same list, because Windows-side `tailscale serve` arrives that way with the
     `ts.net` name (section 6.1).
3. **Owner's Tailscale device.** No credential is needed when all are true:
   - The peer address is a Tailscale address (`100.64.0.0/10` or
     `fd7a:115c:a1e0::/48`).
   - `tailscale whois --json PEER` succeeds and the node's owner is the same
     Tailscale user as this machine's owner (`tailscale status --json`, `Self.UserID`).
     Tagged nodes and nodes shared in from other tailnets do not count.
   - The `Host` header is this machine's MagicDNS name, its short name, or one of
     its Tailscale addresses.
4. **Otherwise**, refuse: `401 {"error":"auth_required"}` for `/api` paths, the
   sign-in page (status 401) for other `GET` paths, and `HTTP/1.1 401` then close
   for a WebSocket upgrade.

After a request passes, the **Origin check** runs (section 7.4).

### 7.2 Why the Tailscale owner check is safe from the LAN

A LAN attacker could send a packet with a forged tailnet source address. The reply
from this machine goes into the Tailscale interface, encrypted to the real peer,
so the attacker never sees the TCP handshake reply and cannot finish the
connection. `whois` also fails for any address that is not a live tailnet peer.
Results are cached per peer address (5 minutes when allowed, 30 seconds when
refused) so the CLI runs rarely. If the `tailscale` command is missing or fails,
the rule does not apply and the client gets the sign-in page.

One residual case: a network that itself uses the `100.64.0.0/10` range with a
route more specific than Tailscale's, and an attacker who knows and takes the
address of the owner's phone. This is unlikely enough to accept and document.

### 7.3 Known hosts

A host is known when its name (port removed) is one of:

- `localhost`, any `127.x.y.z` address, `::1`.
- This machine's Tailscale MagicDNS name and Tailscale addresses (read from
  `tailscale status --json` through `platform.tailscaleStatus`, cached; on WSL
  that falls back to `tailscale.exe`, which gives the Windows host's name). The
  `ts.net` name counts for a loopback or gateway peer only when the request also has
  `Tailscale-User-Login` and no `Tailscale-Funnel-Request` (section 4.3). For a
  tailnet peer (rule 3) the name counts on its own.
- An entry in `~/.dispatch/access.json` (`allowedHosts`), written by
  `dispatch access allow-host NAME`. Read by modification time, so no restart is
  needed.

Not known: any other name, including the machine's `.local` name and LAN address.
Requests to those need a credential.

### 7.4 Origin check

For a request that passed section 7.1:

- No `Origin` header: allowed. Programs on the machine and plain navigations send
  none, and a web page cannot remove it from a cross-origin request.
- `Origin` present: allowed only when its host and port equal the `Host` header
  (same origin), or both are loopback names (the Vite dev server case), or the
  origin is listed in `access.json`. Otherwise `403 {"error":"origin_refused"}`.
  `Origin: null` is refused.
- Applies to every method on `/api` and to **every WebSocket upgrade**.
- `/api` requests with `Sec-Fetch-Site: cross-site` are refused as well. That covers
  cross-site `img` and `no-cors` loads, which send no `Origin` on `GET`. Navigations
  to non-API paths are not affected, so the server switcher keeps working.
- Invariant for reviewers: a `GET` route must not change state. Older browsers do
  not send `Sec-Fetch-Site`, so for them this invariant is the only protection
  against cross-site `GET` loads.

### 7.5 The access token and the browser cookie

- At first start, the daemon writes a random 32-byte token (base64url) to
  `~/.dispatch/access-token` with mode `0600`. It never prints the token to the
  log.
- `dispatch access` prints the token and the sign-in steps. `dispatch access
  rotate` writes a new token, which signs out every browser. `dispatch access
  allow-host NAME` and `remove-host NAME` edit `access.json`.
- The cookie value is `HMAC-SHA256(token, "dispatch-access-cookie-v1")`, so there
  is no session table in Phase 1 and rotating the token revokes every cookie.
- Cookie attributes: `HttpOnly`, `SameSite=Lax` (so the server switcher's
  cross-site navigation still sends it), `Path` equal to the base path or `/`,
  `Max-Age` 400 days, and `Secure` when the request came over HTTPS
  (`X-Forwarded-Proto: https` from a loopback proxy, or TLS).
- Comparison is constant-time (reuse `tokenMatches`, `auth/box-token.ts:24-32`).
- Docs for script users show the token read from a file or an environment
  variable (for example `curl -H @header-file`), never typed into a command line,
  because command lines are visible to other processes and to endpoint agents.

### 7.6 Sign-in page

- A small HTML page inlined in the daemon (no SPA, no assets), served with status
  401 so the service worker does not cache it.
- It says what happened in one sentence, says how to get the token (`dispatch
  access` on the computer that runs Dispatch), and has one field. It posts to
  `POST /api/access/login`, which sets the cookie and redirects to the base path.
- `POST /api/access/login` is the only route open to an unauthenticated client.
  It allows 10 failed tries per peer address per minute, then returns `429`. It is
  still subject to the Origin check.
- A link with the token in the URL fragment (`#access=TOKEN`) also works: the page
  script reads the fragment, posts it, and clears it. The fragment never reaches a
  server log. `dispatch access --link HOST` prints such a link for a phone.

### 7.7 Client changes

Two small ones in `packages/web`:

- `req()` (`api/client.ts:26-41`): on `401` with `auth_required`, reload the page
  once, so an open tab lands on the sign-in page instead of failing quietly.
- Shell poll (`main.tsx:40-50`): on `401`, reload.

The three WebSocket clients need no change: the cookie goes with the upgrade.

### 7.8 What stays the same

- The listen address and the loopback guards.
- All local callers in section 3.2 (loopback peer, loopback `Host`).
- Reveal (`isLocalClient`) and its stricter rule.
- The hosted box token check, which runs first.

### 7.9 Startup notice

One log line at start that states the exposure, for example: `Network: other
devices need the access token (run "dispatch access"). Tailscale devices owned by
you@example.com are allowed.` `dispatch status` prints the same line. No token in
either.

### 7.10 Files touched (for the plan)

- New `packages/core/src/auth/access-gate.ts`: the classifier (pure function of
  peer, `Host`, `Origin`, `Sec-Fetch-Site`, cookie, headers, platform facts) plus
  the Express middleware and the upgrade check.
- New `packages/core/src/auth/access-token.ts`: token file, cookie value, rotate.
- New `packages/core/src/auth/tailscale-whois.ts`: whois and self lookups with
  cache. Reuse the binary lookup from `setup/detect.ts:232-235`.
- New `packages/core/src/auth/known-hosts.ts`: loopback names, Tailscale self,
  `access.json`.
- `packages/core/src/server.ts`: install the gate after `boxGate` (`:463-464`) and in
  the upgrade handler before routing (`:765`).
- `packages/core/src/platform/types.ts`, `wsl.ts`: expose the WSL gateway check as
  its own predicate so Reveal and the gate share it.
- `packages/cli/src/index.ts`: `dispatch access` commands; the status line.
- `packages/web/src/api/client.ts`, `packages/web/src/main.tsx`: the reload on 401.
- Docs: `README.md` remote-access section, one paragraph in `docs/cloudflare.md`
  (section 6.6), a new `docs/network-access.md`, release note.

### 7.11 Phase 1 break list

| Setup | What happens after the update | One-line migration |
|---|---|---|
| Browser on the same computer (`localhost`) | No change. | None. |
| Agents, hooks, MCP tools, `dispatch` CLI | No change (loopback). | None. |
| Tailscale direct from the owner's own phone or laptop (`http://MACHINE.ts.net:3456`) | No change. | None. If the sign-in page appears, the `tailscale` CLI was not found: sign in once with `dispatch access`. |
| Tailscale direct from someone else's device in the same tailnet | Sign-in page. | Give them the token once (`dispatch access`), or share the tailnet node with intent. |
| `tailscale serve` (HTTPS, iPhone PWA) | No change. | None. |
| `tailscale funnel` | Sign-in page (public internet). | Sign in once per browser with the token. |
| Plain LAN (`http://192.168.x.y:3456` or `MACHINE.local:3456`) | Sign-in page. | Sign in once per browser with the token from `dispatch access`. |
| WSL2, NAT mode, Windows browser at `localhost` | No change (gateway rule). | None. |
| WSL2 with Windows-side Tailscale and `tailscale serve` | No change (gateway peer, `ts.net` Host, identity header). | None. |
| WSL2 with `tailscaled` inside WSL, phone at the tailnet address | No change (owner check runs inside WSL). | None. |
| WSL2, mirrored mode, Windows browser at `localhost` | Expected no change (loopback); to be confirmed by the WSL test (6.1). | None if confirmed. |
| WSL2 with a `netsh portproxy` for LAN access | LAN browsers get the sign-in page. | Sign in once per browser with the token. |
| Scripts that call the API from another machine | `401`. | Add `Authorization: Bearer TOKEN`. |
| Vite dev server (`pnpm dev`) | No change (loopback origin allowed). | None. |
| Hosted box | No change (box token is a credential). | None. |
| An open browser tab on a LAN address during the update | Reloads to the sign-in page. | Sign in. |

Not in the table: an unknown user behind another reverse proxy or tunnel
(Cloudflare or similar) sees the sign-in page and uses section 6.6.

### 7.12 Residual risks after Phase 1

- **R-1. A host added with `allow-host`.** The daemon trusts it like `localhost`,
  so the proxy behind that name must have its own sign-in. `tailscale funnel` is
  not affected: it gets the sign-in page.
- **R-2. WSL with a LAN portproxy.** Traffic through a Windows portproxy arrives
  from the gateway address, the same as the Windows browser, and the attacker
  controls `Host`. Only users who added a portproxy on purpose are affected
  (Dispatch never documents one). Phase 2 closes it with a `127.0.0.1` listen on
  WSL. The release note tells these users to remove the portproxy and use
  Tailscale.
- **R-3. Other OS users on the same machine.** Loopback is trusted (4.2).
- **R-4. A LAN that uses `100.64.0.0/10`** with a route more specific than
  Tailscale's, plus an attacker who takes the address of the owner's own device
  (7.2). Accepted.
- **R-5. The token file.** Anything running as the user can read
  `~/.dispatch/access-token`. Same as every other secret in `~/.dispatch`.

### 7.13 Security headers (SEC-09, added 2026-10-23)

Every HTTP response, including the sign-in page and error responses, carries:

- `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`, so
  no other site can frame Dispatch and overlay fake buttons on it.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: same-origin`, so file paths and session IDs in URLs do not leak
  to other sites.

Phase 1 does **not** send a script CSP. The web app and the doc viewer render
Markdown and HTML, and a strict `script-src` needs a separate pass over the client
(overview finding SEC-08). The headers above do not block inline scripts, styles,
WebSockets or images, so the app keeps working. No route needs to be framed by
another site, so `DENY` applies everywhere.

### 7.14 Private data directory (SEC-18, added 2026-10-23)

The overview suggested `process.umask(0o077)`. Phase 1 uses directory and file modes
instead, because a process-wide umask is inherited by every terminal and agent the
daemon spawns, and would make every file an agent creates in a project `0600`. A
`0700` directory gives the same protection for the data, because other accounts
cannot traverse into it whatever the modes of the files inside.

At start, before the database opens, the daemon:

- creates the data directory with mode `0700` and runs `chmod 0700` on it when it
  already exists. It does the same for the log directory.
- creates `dispatch.db` with mode `0600` when it does not exist, and runs
  `chmod 0600` on `dispatch.db`, `dispatch.db-wal`, `dispatch.db-shm`, `access-token`
  and `access.json` when they exist.
- logs a warning and keeps starting if a `chmod` fails. Paths on a Windows mount
  (`/mnt/c`) cannot hold Unix modes; there the step skips without a warning.

Files that other code writes inside the data directory stay at their own modes;
the `0700` directory covers them.

### 7.15 Owner decisions (resolved 2026-10-23)

- **NE-1:** David Webber reviews the Phase 1 PR the same day it opens, before any
  release. The PR body says so. The build agent does not contact him.
- **NE-3:** option A. Only devices on the owner's own Tailscale account skip
  sign-in. Coworkers on a shared tailnet must sign in.
- **NE-4:** no switch to turn the gate off.

## 8. Phase 2 design: full access model

Phase 2 replaces "paste the token" with device pairing, gives the owner a settings
page, and makes exposure visible. It needs its own implementation plan.

### 8.1 Paired devices

- A device session table in the existing SQLite database: random session ID
  (stored hashed), device name (from the user agent, editable), created, last seen,
  last address.
- The cookie becomes the session ID. The Phase 1 HMAC cookie is still accepted
  until it is next used, then swapped for a session (no forced sign-out).
- **Pairing:** a trusted client (local browser or a paired device) opens Settings >
  Network and devices > Add a device. The daemon makes a one-time pairing secret
  valid for 5 minutes and shows (a) a QR code of `URL#pair=SECRET` and (b) a
  6-digit code. The new device scans the QR code or types the code on the sign-in
  page. Codes are rate limited and single use.
- The setup wizard's Mobile step (`SetupWizard.tsx:126-160`) puts a pairing secret
  in its QR code, so a phone that is not on Tailscale can pair in one scan.
- Revoke per device, and "sign out every device" (rotates the token too).

### 8.2 Settings page: Network and devices

- **Who can connect:** "This computer only" (listen on loopback), "This computer
  and my devices" (all interfaces, gate on; the Phase 1 behaviour), with a plain
  description of each.
- Known hosts list (auto-found entries marked as such), with add and remove.
- Tailscale rule: "my devices only" (default) or "anyone in my tailnet".
- Paired devices list.
- The current exposure in one sentence, for example "Reachable from other devices
  on Wi-Fi network X. They need to pair first."

### 8.3 Listen address

- New setting `bind`: `loopback` or `all`, stored in `access.json`, with an env
  override `DISPATCH_BIND` that the CLI passes through (`cli/src/index.ts:634-649`).
- `loopback` listens on `127.0.0.1` and `::1` directly on macOS and Linux; the
  loopback guards are then not needed (`loopback-guard.ts`). On WSL it listens on
  `127.0.0.1` only, because of the `::1` relay hang (6.1).
- The local callers that use `localhost` (the CLI and both MCP servers, section
  3.2) change to `127.0.0.1`, so they never depend on `localhost` resolving to
  `::1` first.
- Default for **new** installs: chosen in onboarding, preselected "this computer
  only" when Tailscale is not installed. Existing installs keep `all` (gated).
- On WSL, `loopback` is offered only after the WSL check in section 6.1 confirms
  that the Windows browser still reaches it.

### 8.4 Exposure warning

- Onboarding step "Use Dispatch from other devices?" with the three choices above.
- An app banner when the daemon is reachable on a non-loopback address and no
  device has ever paired, with a link to the settings page. Dismissible.
- The browser shows a one-time notice the first time a new device signs in
  ("A new device signed in from ADDRESS"), and a push notification if push is on.

### 8.5 Proxy-specific checks: not planned

No check for a particular proxy (for example the Cloudflare Access JWT). Add one
only if a real user needs it.

### 8.6 Docs

- README: recommend `tailscale serve` (HTTPS, PWA install, push) over the raw port.
- `docs/network-access.md`: the model, the setups, how to pair, how to rotate.

### 8.7 Optional hardening

- "Require a credential on this computer too", for shared machines. Local
  callers then need the token: hooks and the shim read it from the spawn env (never
  from argv), MCP servers get it in their env block. Off by default.

## 9. Migration and communication

- **Release:** Phase 1 as v3.4.0 (behaviour change). The update prompt and the
  release note headline say "Security fix: other devices now need to sign in".
- **The fix reaches only installs that update.** The in-app update prompt already
  appears on every install (`update/checker.ts`). The release note should say
  that the update is important.
- **Repository owner sign-off:** Phase 1 changes default behaviour for every user,
  so the repository owner should review the Phase 1 PR. See decision NE-1.
- **Public issue:** issue 94 is public and already describes the problem, so the
  release note can be factual. It should not give step-by-step attack details.

### 9.1 Release note text (draft)

> **Security fix: other devices now need to sign in.**
>
> Before this release, any device on the same network as your computer (for
> example a coffee shop or hotel Wi-Fi) could open your Dispatch and run commands as
> you. A web page you visited could also connect to it. This release closes both.
>
> What changes for you:
> - On the computer that runs Dispatch, nothing changes.
> - Your own devices on Tailscale (direct or through `tailscale serve`) keep working
>   with no steps.
> - Any other device (for example a laptop on the same Wi-Fi) shows a sign-in page
>   once. Run `dispatch access` on the computer that runs Dispatch to get the access
>   token, then paste it.
> - If you put another proxy or tunnel in front of Dispatch, sign in once, or run
>   `dispatch access allow-host YOUR.HOSTNAME` once.
> - On Windows (WSL2), if you added a `netsh portproxy` rule so other devices can
>   reach Dispatch, remove it and use Tailscale instead. That path is not yet
>   protected.
>
> Please update now.

## 10. Testing plan

### 10.1 Automated (Phase 1)

- Classifier table tests in `access-gate.test.ts`: every row of section 7.11 as a
  case (peer address, `Host`, `Origin`, `Sec-Fetch-Site`, cookie, bearer, box
  token, platform flavor), including `::ffff:127.0.0.1`, bracketed IPv6 `Host`,
  `Host` with and without port, WSL gateway with a non-loopback `Host`, `Origin:
  null`, and the Vite dev case.
- Tailscale tests with a fake `whois`: same user, other user, tagged node, command
  missing, cache expiry.
- `allow-host` tests: an added name passes from loopback, a removed name does not,
  an added name does not help a LAN peer.
- Integration tests with a real listen on a random port: HTTP 401, sign-in page,
  login sets the cookie, the cookie opens `/api` and all three WebSockets, a
  foreign-Origin WebSocket gets 401 or 403, rotation revokes the cookie, login rate
  limit.
- Server-side regression: hooks, codex-notify and the shim still post to
  `127.0.0.1` with no token.
- SEC-03 cases: a `text/plain` POST and a multipart POST with a foreign `Origin`
  are refused with `403 origin_refused` (mkdir, upload, DELETE).
- SEC-09: every response (200, 401, 403, sign-in page) has the headers of 7.13.
- SEC-18: with a permissive umask, a fresh data directory is `0700`, a new database
  file is `0600`, and an existing `0755` directory and `0644` database are tightened
  at start. The daemon process umask is not changed.

### 10.2 Manual on macOS (can do here)

Use a test daemon on port 3480 with a temporary `HOME`, never the live daemon.

1. From a second device on the same Wi-Fi with Tailscale off (an iPhone or another
   laptop): open `http://LAN-IP:3480`. Expect the sign-in page. `curl` to
   `/api/sessions` expects `401`. Sign in with the token and use a terminal.
2. Same device with Tailscale on, same owner: open the `ts.net` name on port 3480.
   Expect no sign-in.
3. `tailscale serve` to the test port: open over HTTPS on the phone. Expect no
   sign-in. If Funnel can be turned on briefly, expect the sign-in page from a
   phone on mobile data.
4. Rebinding check: add a hosts entry for a test name that maps to `127.0.0.1` in
   a test browser profile, open the test name. Expect the sign-in page, not the app.
5. Cross-site WebSocket: a local HTML page on another origin opens
   `ws://localhost:3480/api/events`. Expect the upgrade to fail.
6. Start a Claude thread and a Codex thread on the test daemon. Expect status
   updates, MCP tools and the browser shim to work.

### 10.3 Needs someone else

- **WSL2** (a WSL2 user, named in the local companion, or a cloud Windows machine as
  in the July Tier-3 pass): NAT mode Windows browser at `localhost`; mirrored mode
  Windows browser at `localhost`; a LAN device in mirrored mode (expect sign-in);
  `tailscaled` inside WSL from a phone (expect no sign-in); Windows-side Tailscale
  plus `tailscale serve`. For Phase 2 only: a loopback-only listen with the Windows
  browser in NAT and in mirrored mode.
- **Tailscale users:** one other user on Tailscale tests the release candidate
  from their own phone (direct and, if they use it, `tailscale serve`).

## 11. Related known limit: confined doc read

`packages/core/src/docs/confined.ts` has a documented race: a process running as
the same user can swap a parent directory for a symlink between the checks and get
the doc viewer to show a file outside the project. This fix does **not** change
that race. It removes every remote way to reach the viewer, so the only way left to
use the race is a same-user process, which can read the file directly anyway. That
matches the issue comment: once the daemon is authenticated, no separate fix is
needed. A full fix would need `openat`-style confined opens, which Node does not
offer. It stays a documented limit.

## 12. Open questions (all resolved 2026-10-23)

The owner accepted every recommendation (see 7.15).

1. **NE-1 (resolved: yes, David Webber, same day): Does the repository owner review Phase 1 before release?**
   Recommended: yes. Open the PR, ask for review the same day, and release after
   approval. Phase 1 changes default behaviour for every install.
2. **NE-2:** folded into NE-4. No current user is known to run Cloudflare or
   another proxy, so there is no separate proxy decision.
3. **NE-3 (resolved: A): Tailscale rule scope in Phase 1.** (A) Only devices owned by the same
   Tailscale user. (B) Any device the tailnet ACL allows (today's behaviour).
   Recommended: A. In a company tailnet, B gives coworkers a shell.
4. **NE-4 (resolved: no switch): A switch to turn the gate off.** Recommended: no switch. The token
   sign-in works in every setup, and a switch would be turned on and forgotten. An
   unknown user behind another proxy or tunnel also has `allow-host` (6.6). Do not
   trust a proxy's own header (for example `Cf-Access-Jwt-Assertion`) without
   checking it: a rebinding page can send it.
