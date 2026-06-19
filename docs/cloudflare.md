# Exposing Dispatch with Cloudflare Tunnel + Access

This makes your local daemon reachable at a real HTTPS hostname
(e.g. `https://dispatch.example.com`) and gates it behind **Cloudflare Access** so only people
you allow can sign in. Nothing is exposed by opening a port — the tunnel dials **out** from
your Mac to Cloudflare.

Replace `dispatch.example.com` with your own hostname throughout.

## Prerequisites

- A domain whose DNS is managed by Cloudflare (added to your Cloudflare account).
- **Cloudflare Zero Trust** enabled on your account (free tier is fine) — dash.cloudflare.com → **Zero Trust** (pick a team name if first time).
- `cloudflared` installed:

  ```bash
  brew install cloudflared
  ```

- Dispatch already running locally (`dispatch status` → reachable at `http://localhost:3456`).

---

## 1. Authenticate cloudflared

```bash
cloudflared tunnel login
```

A browser opens — pick the domain (zone) you want to use. This writes a cert to
`~/.cloudflared/cert.pem`.

## 2. Create a tunnel

```bash
cloudflared tunnel create dispatch
```

This prints a **Tunnel ID** and writes a credentials file to
`~/.cloudflared/<TUNNEL-ID>.json`. Keep this file secret (it's your tunnel's key).

## 3. Configure ingress

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: dispatch
credentials-file: /Users/YOU/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: dispatch.example.com
    service: http://localhost:3456
  - service: http_status:404
```

WebSockets (terminals, live events) are proxied automatically — no extra config needed.
Dispatch also pings WebSocket clients every 30s so they survive Cloudflare's ~100s idle
timeout.

## 4. Point DNS at the tunnel

```bash
cloudflared tunnel route dns dispatch dispatch.example.com
```

This creates the `CNAME` for `dispatch.example.com` → your tunnel.

## 5. Run the tunnel

Quick test (foreground):

```bash
cloudflared tunnel run dispatch
```

Visit `https://dispatch.example.com` — you should reach Dispatch (you'll add auth next).

Run it permanently as a background service so it survives reboots:

```bash
sudo cloudflared service install
```

On macOS this installs a launchd daemon that uses your `~/.cloudflared/config.yml`. (See
<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/> for details.)

---

## 6. Gate it with Cloudflare Access (authentication)

Without this, anyone with the URL can reach your machine. Add an Access policy so only you can
sign in:

1. **Zero Trust dashboard → Access → Applications → Add an application → Self-hosted.**
2. **Application domain:** `dispatch.example.com`.
3. **Add a policy:**
   - Action: **Allow**
   - Include → **Emails** → your email address (or **Emails ending in** your domain).
4. Choose login methods under **Settings → Authentication** — **One-time PIN** works out of
   the box (email a code); or connect Google / GitHub / etc. as an identity provider.
5. **Save.**

Now `https://dispatch.example.com` shows a Cloudflare Access login first; after you
authenticate, the Dispatch app loads.

> The PWA "install" option (Add to Dock / Home Screen) appears on this HTTPS hostname because
> it's a secure origin. Plain `http://…:3456` is not installable.

---

## Verify

1. Open `https://dispatch.example.com` in a fresh browser.
2. Complete the Access sign-in.
3. You should see your projects and be able to open a terminal.

If the page hangs or 502s, check both halves:

```bash
dispatch status                 # the app itself
cloudflared tunnel info dispatch   # the tunnel
```

---

## Alternative: Tailscale (private, no public domain)

If you only need access from your own devices, install [Tailscale](https://tailscale.com) on
the Mac and your phone/laptop, and reach the daemon directly at
`http://<machine>.<tailnet>.ts.net:3456`. No domain or Cloudflare needed — but note this is
plain HTTP, so the browser **won't offer PWA install** on those origins. Use the Cloudflare
HTTPS hostname when you want to install the app.
