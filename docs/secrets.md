# Secrets (Doppler)

Dispatch connects to one Doppler project and config (Settings, Secrets). Threads use the secrets
in three ways:

1. **The Doppler tools** (`doppler_list_secrets`, `doppler_get_secret`, and the write tools when
   read-only is off). Dispatch adds them to a thread when Doppler is connected.
2. **Integrations** that name a secret as `${NAME}`. The integration launcher reads the value when
   the integration starts.
3. **`doppler run -- <command>`** in the thread's shell. This needs `DOPPLER_TOKEN` in the
   thread's environment.

## Token scope

The token scope says which threads get `DOPPLER_TOKEN` in their environment.

| Scope | Select in Settings, Secrets | Result |
|---|---|---|
| `all` | Every thread | Each thread process has `DOPPLER_TOKEN`. This is the behaviour of every version before v4.5.0. |
| `opted-in` | Only threads that I turn on | A thread has `DOPPLER_TOKEN` only after you turn on its switch. |

The Doppler tools (1) and the integrations (2) do not use the environment. The Doppler tool server
starts with `--secrets-dir` and reads the saved connection, as the integration launcher does. The
MCP config files that Dispatch writes hold no `${DOPPLER_TOKEN}` reference. Thus the tools and the
integrations work in both scopes with no action.

`DOPPLER_PROJECT`, `DOPPLER_CONFIG` and `DOPPLER_READ_ONLY` are in each thread's environment in
both scopes. They are not secrets.

### The switch for one thread

With the scope `opted-in`, the thread menu has a switch under More: "Doppler token in this
thread's shell". The switch is not shown with the scope `all`.

- The switch takes effect at the next start of the thread. Use "Reload thread" to apply it at once.
- Only the owner can change it, from the web page or with the access token. A thread key cannot.
- The API is `PUT /api/terminals/ID/secrets-env` with `{ "enabled": true }`.
- A Codex thread in the Pretty view has no switch. All Codex Pretty threads share one process, and
  that process holds nothing that belongs to one thread. Use the Codex CLI view for `doppler run`,
  or use the Doppler tools.

### Migration

- **An existing install keeps `all`.** A saved connection with no scope reads as `all`. Nothing
  changes until you change the select.
- **A new connection starts as `opted-in`.** This applies when no token was saved before, also
  after a Disconnect.
- **After you change to `opted-in`:** a thread that runs `doppler run` in its shell needs the
  thread switch, and then a restart of the thread (Reload thread). A thread that is already
  open keeps the environment of its start until it restarts.
- **The Doppler tools and all integrations work in both scopes with no action.**
- With `opted-in`, the `doppler` row in Settings, Tools can show "needs sign-in". The check runs
  with the shared environment, and that environment has no token now. `doppler run` in a thread
  with the switch on works.
- If the daemon gets `DOPPLER_TOKEN` from its own environment and no token is saved in Dispatch,
  the behaviour is the old one: every thread inherits the token from the daemon.

### What the scope does not do

The saved connection is a file, `~/.dispatch/doppler.json`, with mode `0600`. Each program that
runs as the same macOS user can read that file. An agent runs as you.

The scope `opted-in` removes the token from each thread's process environment and from the `ps`
listing. It keeps the token out of a child process that prints or logs its environment. It is
**not** an operating-system boundary: it does not stop a program that reads the file on purpose.

## Read-only

With read-only on, the write tools are not given to threads and the daemon refuses writes.

## Values stay out of the transcript

`doppler_list_secrets` gives names only. `doppler_get_secret` gives a value only with
`reveal: true`. The prompt tells a thread to use the Doppler tools, and to use `doppler run` when
`$DOPPLER_TOKEN` is set in the shell, so that a value goes to the command's environment and not to
the transcript.
