# Integrations

**Settings → Integrations** holds MCP servers you add once and every agent thread gets:

- **Remote** — a URL plus optional headers. Dispatch runs it through
  `npx -y mcp-remote <url> --header <Name>:<value>`.
- **Local command** — a command, args and optional env, run as a stdio MCP server.

## How a thread gets them

- **Every harness:** Claude Code, Codex, Grok and OpenCode threads, CLI and structured alike.
- **At thread start.** Dispatch reads the enabled integrations each time it starts a thread's
  CLI (new, resume, relaunch). Adding, removing or toggling one applies to the next start,
  not to a thread that is already running.
- **Added to your own MCP config, never replacing it.** Each harness gets them through its
  per-thread injection:

  | Harness     | How the servers arrive                                                            |
  | ----------- | --------------------------------------------------------------------------------- |
  | Claude Code | `--mcp-config <per-thread file>`, without `--strict-mcp-config`                    |
  | Codex       | `-c mcp_servers.<name>.*` overrides (CLI) or the thread `config` (structured)      |
  | Grok        | a per-thread plugin (`GROK_HOME` for CLI threads, `--plugin-dir` for structured)   |
  | OpenCode    | the per-thread config file named by `OPENCODE_CONFIG`                              |

## Secrets: `${NAME}`

Put a secret in an integration as a reference, never as the value:

```
Authorization=Bearer ${LINEAR_API_KEY}     # a remote header
GITHUB_TOKEN=${GITHUB_PAT}                 # an env value (remote or local)
```

- **Where a ref works:** a remote **header value** or an **env value**. `NAME` is letters,
  digits and `_`, not starting with a digit.
- **Where it does not:** the URL, the command, or the args. Those land on a command line,
  so Dispatch never resolves a ref there.
- **Where the value comes from:** when the server starts, Dispatch reads `NAME` from Doppler
  — the project/config connected in **Settings → Secrets**, if Doppler is connected and on.
  If Doppler does not have it, the server's own environment is the fallback. Codex hands MCP
  servers only a short default environment, so under Codex keep the secret in Doppler.
- **If it can't be found:** the server does not start, and the CLI's MCP log gets one line
  that names the ref and the Doppler project/config (never a value), for example
  `dispatch integration "linear": cannot resolve ${LINEAR_API_KEY}: not set in Doppler (acme/dev) or the environment`.
- **Where the value goes:** only into the MCP server process's environment. It is never in
  a command line (an EDR agent can log every process's argv), a config file, `dispatch.db`,
  a log line, or the agent's own shell environment.
- **Where the server's stderr goes:** to its own log,
  `~/.dispatch/logs/integrations/<name>.log` (folder `0700`, file `0600`, rotated once to
  `<name>.log.1` at about 1 MiB), never to the CLI. The CLI keeps MCP stderr in its own logs,
  and a server can print a value in forms no filter can catch (an object dump with escapes,
  a 1–3 character value). The log redacts the verbatim and JSON-escaped forms of values of
  4+ characters, but it can still hold other encodings of a value, which is why it is `0600`.
  Every thread runs its own copy of the server, so lines from several threads can mix in one
  log; `--- … pid N: started ---` and `exited` markers separate the runs.
- **What the CLI's MCP log gets:** fixed lines only. Nothing on a normal run;
  `dispatch integration "<name>": exited with code N; its stderr is in <path>` when the
  server fails; and the lines for a missing ref, a spawn error (its code only), or a bad value.
- **Bad values:** the launcher refuses to start a server when a value has a NUL byte (or a
  CR/LF, in a header).
- **Literal values keep today's path.** An env value without a ref goes to the harness
  exactly as before (the per-thread config file for Claude Code; for a Codex CLI thread that
  path is a `-c` flag on its command line). A literal header value is always on the
  `mcp-remote` command line. So write every secret as `${NAME}`, never as a literal.

How it works: an integration with a ref runs as
`node dist/integrations/launcher.js --secrets-dir <dir> --spec <base64 JSON>`. The spec holds
the templates only: the URL, command, args, headers, and the env entries that contain a ref.
Base64 is an encoding, not a protection, so nothing secret goes into it. The launcher
resolves each ref, then starts the real server with the values in that server's
environment. For a remote server the header template stays literal on the `mcp-remote`
command line, and `mcp-remote` fills in `${NAME}` from its environment.

An integration without refs runs exactly as it did before. A Doppler change takes effect
the next time the server starts. The launcher is part of the built daemon (`dist/`); under
`pnpm dev` (tsx) integrations keep their plain, unresolved spec.
