# Node version: one-time recovery for an install stuck on the old updater

Dispatch needs Node 22.13 or newer. The repo's `.nvmrc` used to say 20. A shell that reads `.nvmrc`
(fnm with use-on-cd, nvm) then ran Node 20 inside the repo, and `dispatch update` failed in pnpm 11 with
`No such built-in module: node:sqlite`.

The `.nvmrc` now says 22. The updater now builds with the Node the daemon was installed with, not the
Node the shell picked. An install that still runs the old updater needs one manual step to get there.

Use the Node your daemon was installed with. Replace `24` with its major version.

If `dispatch update` fails before it pulls anything:

```bash
fnm exec --using 24 ./bin/dispatch update
```

If the pull already happened and the build failed:

```bash
fnm exec --using 24 ./bin/dispatch build
fnm exec --using 24 ./bin/dispatch restart
```

Without fnm, put that Node first on PATH for the same commands. Run them from the Dispatch checkout.

After this, plain `dispatch update` works from any shell.

If `dispatch build` stops with a message about the daemon's node, that Node is missing or older than
22.13. Install a working one, then run `dispatch install` and `dispatch build` under it.
