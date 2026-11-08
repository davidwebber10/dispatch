# Settings screenshots

Before/after previews of every Settings section, phone (390x844, touch) and desktop (1440x900),
from an isolated daemon with a fake HOME. It never touches the real `~/.dispatch`.

## Run

From the worktree root, after a build:

```bash
pnpm build                     # the script builds nothing; it serves packages/web/dist
PORT=3996 SCRATCH=/path/to/your/scratchpad scripts/settings-shots/run.sh after-<group>
```

- `PORT`: a free port. Each worker uses its own (3991, 3992, …); the script refuses a busy port.
- `SCRATCH`: your scratch folder. The fake HOME is `$SCRATCH/settings-shots/home-$PORT` (made
  fresh each run); the images go to `$SCRATCH/settings-shots/<label>/`; the daemon log is
  `$SCRATCH/settings-shots/daemon-$PORT.log`.
- A second argument limits the shots: `run.sh after-you appearance,notifications,dictation,index`.
  Keys: `index appearance notifications dictation agents accounts usage integrations secrets tools
  devices servers plugins skills about coach`.

Output: `<key>-phone.png`, `<key>-desktop.png`, `index-phone.png`, `index-desktop.png`. Each image
holds the whole section (the viewport grows until nothing scrolls).

The script stops only the daemon it started. A web change needs `pnpm --filter dispatch-web build`
before the run (the daemon reads `index.html` at start, and each run starts it fresh).

## What it does

1. `seed.mjs files <home>`: project folders, `accounts.json` (Claude "Work" with a fake token,
   Codex "Personal" not signed in).
2. Starts `node packages/core/dist/server.js` with `HOME=<fake>`, `DISPATCH_TELEMETRY=0`,
   `DISPATCH_WEB_DIST=<worktree>/packages/web/dist`, and without the thread's `DISPATCH_*` env.
3. `seed.mjs api <url> <home>/.dispatch/access-token`: 6 projects, 4 shell threads, 3 skills (one
   off), 3 integrations (one off), 2 servers, 2 signed-in devices (pair code + login, renamed),
   2 push subscriptions, 1 local plugin (`daily-rundown`).
4. Stops the daemon; `seed.mjs db <home>` writes usage-limit figures (Claude CLI 42/71/18%,
   Claude Work 88/54%, Codex 12/33%) into `app_state`; starts it again.
5. `shoot.mjs <url> <outDir> [only]` takes the shots.

## What it cannot seed

- **Secrets**: needs a real Doppler token; the section shows its "connect" state.
- **Tools**: the fake HOME has no `~/.dispatch/tools`, so every tool shows "not installed".
- **Real CLI logins**: Claude/Codex CLI accounts show as "the CLI's own login"; nothing is signed in.
- **Marketplaces / catalog**: needs a git clone; Plugins shows no marketplaces.
- **An update waiting**: the About page shows "up to date" style content only.
- **Push on this device**: the headless browser has no push permission; the switch is off.

## Playwright

Not a repo dependency. `shoot.mjs` uses `import('playwright')` if it resolves, else
`$PLAYWRIGHT_MODULE`, else the newest `~/.npm/_npx/*/node_modules/playwright`. It launches that
version's Chromium, or the installed Google Chrome. If none works:
`npx -y playwright@latest install chromium` once, then run again.
