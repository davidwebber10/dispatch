# Browser-auth relay

How a sign-in that wants a browser reaches you when Dispatch is running on another machine.

A CLI in a thread needs you to authenticate. You are on your phone. The relay catches the
sign-in URL, shows it in a banner, and takes the callback back.

---

## The loop

```
     a CLI in a thread wants a browser
                  │
      ┌───────────┼───────────┐
      │           │           │
   $BROWSER   open /       it just
    shim      xdg-open     PRINTS the URL
      │        shim            │
      │           │            │  (terminal output is scanned)
      └───────────┼────────────┘
                  ▼
        POST /api/auth-requests
                  ▼
          AuthRequestService
                  ▼
       AuthBanner — "Authentication required" (sign-in URLs)
                  or "Link to open" (any other URL a shim relays)
                  │
      you tap "Open in browser" on your phone
                  ▼
        you sign in at the provider
                  ▼
     the provider redirects to http://localhost:PORT/callback?code=…
     which your phone CANNOT reach — the CLI's server is on the daemon host
                  ▼
     copy that failed URL, paste it into the banner
                  ▼
       POST /api/auth-requests/:id/callback
                  ▼
     the daemon fetches it locally — the CLI's own server sees the callback
                  ▼
                 signed in
```

On the daemon's own machine there is nothing to paste: the redirect resolves by itself.

---

## The three triggers

A CLI can ask for a browser in three ways, and each needs its own catch. All three raise the
same auth request, distinguished by `source`.

| `source` | Trigger | Covers |
| --- | --- | --- |
| `browser-env` | `$BROWSER` / `$GH_BROWSER` point at `dispatch-open` | CLIs that honour the convention |
| `system-opener` | `open` and `xdg-open` are shadowed on `PATH` | CLIs that exec the platform opener directly — the common case on macOS |
| `terminal-output` | The thread's output is scanned for sign-in URLs | Device-code grants, which exec nothing at all and only print a URL |

The shims relay **any** http(s) URL, not just sign-ins — an agent opening an artifact preview
or a docs page arrives through the same pipe. The banner therefore classifies client-side:
a `terminal-output` request is a sign-in by construction, and a shim-relayed URL is checked
against the same signal list (mirrored in `AuthBanner.tsx`). A non-sign-in URL renders as
"Link to open" and hides the callback-paste field, which only makes sense for OAuth.

`$BROWSER` alone was never enough. Measured against a real PTY, `gh auth login --web` never
invokes it in any configuration — despite the flag name it is a device-code grant that prints
a code and a URL and polls in the background, with no browser launch and no local callback
server (commit `2823ecb`).

### The opener shims delegate

`open` and `xdg-open` in the shim bin dir relay **only** an `http(s)` first argument. Anything
else — `open .`, `open -a Xcode file.swift` — is passed straight to the real binary with argv
intact. `open` is only shadowed where a real one exists, so the name stays free on Linux.

### Output scanning is deliberately narrow

A false banner is worse than a missed one, so a URL is relayed only if it is `https`, is not
loopback, and contains an unmistakable sign-in signal (`oauth`, `authorize`, `login`,
`device`, `verify`, `activate`, `user_code`, `sso`, …). Ordinary links an agent prints —
release pages, docs, registries — are ignored.

Two hazards it handles, both learned the hard way:

- **Hard wrapping.** A terminal breaks a long line at its width with no space, splitting a URL
  mid-string. Lines at least 60 characters long are rejoined; shorter ones are genuine line
  breaks, so `…/login/device\nEnter code` never becomes `…/login/deviceEnter`. Same class of
  bug as the wrapped login token in commit `0138bf0`.
- **Still-streaming URLs.** A URL at the very end of the buffer may not have finished
  arriving, so it is held until more output follows. Without this the same URL raised two
  banners — once truncated with the shell's `%` prompt marker glued on, once complete.

Each terminal reports a given URL once, and at most 10 distinct URLs.

---

## PATH composition — the failure that made all of this silent

The spawn environment is merged from three contributors — the secrets service, the bundled
tools, and this shim — and **each one builds `PATH` by prefixing `process.env.PATH`**. Merging
them with object spread means the last one wins and the others' prefixes disappear.

That is how the relay came to be dead: `$BROWSER=dispatch-open` was set correctly, but
`dispatch-open` was not on `PATH`, so any CLI honouring it got "command not found" and the
user saw nothing. It fails silently by design — the shim is best-effort and swallows errors.

`withShimPath()` re-asserts the shim's bin dir after the merge (`server.ts`'s
`refreshPtyEnv`). **Any new contributor to the spawn environment must compose `PATH` rather
than assign it**, or it will break the relay the same way.

---

## Where the pieces live

| Concern | File |
| --- | --- |
| The shims and `withShimPath` | `packages/core/src/auth/shim.ts` |
| Sign-in URL detection | `packages/core/src/auth/url-detect.ts` |
| Output scanning hook | `packages/core/src/terminal-monitor.ts` |
| Request state + callback forwarding | `packages/core/src/auth/service.ts` |
| HTTP surface | `packages/core/src/routes/auth.ts` (`/api/auth-requests`) |
| The banner | `packages/web/src/components/auth/AuthBanner.tsx` |

## Checking it yourself

In any thread:

```bash
command -v open dispatch-open   # both must resolve into <dataDir>/bin
echo "$BROWSER"                 # dispatch-open
```

If `open` resolves to `/usr/bin/open`, the `PATH` merge has regressed — see above.
