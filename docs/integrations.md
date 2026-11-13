# Integrations

**Settings → Integrations** holds MCP servers you add once and every agent thread gets:

- **Remote** — a URL plus optional headers. Dispatch runs it through
  `npx -y mcp-remote@0.14.3 <url> --header <Name>:<value>` (the version is pinned in `packages/core/src/integrations/launcher.ts`).
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
- **Where the server's stderr goes:** to a log file, never to the CLI. The CLI keeps MCP
  stderr in its own logs, and a server can print a value in forms no filter can catch (an
  object dump with escapes, a 1–3 character value). Every thread runs its own copy of the
  server, and each copy writes its own file,
  `~/.dispatch/logs/integrations/<name>.<pid>.log` (`<pid>` is the launcher's), so no file
  is shared. The folder is `0700` and the file `0600`; at about 1 MiB it rotates once to
  `<name>.<pid>.log.1`. The log redacts the verbatim and JSON-escaped forms of values of
  4+ characters, but it can still hold other encodings of a value, which is why it is `0600`.
- **Log retention:** each time a server starts, Dispatch prunes that integration's logs. It
  never touches the log of a launcher that is still running. Of the finished ones, it keeps
  the 5 newest and deletes the rest, and it deletes any finished one older than 7 days. It
  also sets kept files to `0600` and deletes the single shared `<name>.log` of earlier builds.
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

## Company tools on a hosted box (one server per system)

A box that POLYWOOD OS provisions (`OS_BASE_URL` + `OS_BOX_TOKEN`) asks OS
`GET /api/dispatch/connections` for the person's tools. When the answer has `osTools: {url}`,
the daemon reads OS's tool list (`tools/list`, each tool's `system`) and every agent thread gets
ONE MCP server PER SYSTEM that has a tool for the person (`os/os-servers.ts`):

| Gateway tool | Server | Tool in the thread | Claude Code name |
| --- | --- | --- | --- |
| `acumatica_get_customer` | `acumatica` | `get_customer` | `mcp__acumatica__get_customer` |
| `google_drive_search_files` | `google-drive` | `search_files` | `mcp__google-drive__search_files` |
| `data_query`, `display_chart` | `data`, `display` | `query`, `chart` | `mcp__data__query` |
| `os_list_connections` | `connections` | `list` | `mcp__connections__list` |

```
thread CLI --HTTP (or the stdio bridge), thread key--> POST /api/os/mcp/<system> (loopback only)
           --box token, owner, thread id, x-dispatch-systems: <system>, gateway tool name--> osTools.url
```

- **The box maps the names.** The route drops the system prefix in `tools/list`, puts it back in
  `tools/call`, and sends `x-dispatch-systems` per server, so OS needs no change. Results,
  `structuredContent` and markers pass through unchanged.
- **The box token never reaches a thread.** A thread sends its own key; only the daemon adds
  `x-dispatch-box-token`, `x-dispatch-owner` and `x-dispatch-thread-id`. The route refuses any
  caller that is not a thread key on a loopback address.
- **No extra process where the harness allows it.** Claude Code, the Codex CLI, Codex Pretty and
  OpenCode get a loopback HTTP entry with the key as a reference (`Bearer ${DISPATCH_AUTH}`,
  `bearer_token_env_var`, `{env:DISPATCH_AUTH}`; Codex Pretty: the literal over its pipe). Grok and
  the Codex CLI view (key file) run `dist/os/os-mcp-bridge.js` once per system (about 50 MB each).
- **Which systems.** A system with a tool in OS's list, minus one that still needs consent. A
  running thread keeps the servers it started with; a new thread gets the new set. A server the
  person already has keeps its name; the OS one becomes `os-<name>`.
- **Instructions.** OS's `initialize` instructions ride the `data` server only (else
  `connections`), with gateway names written `data.guide`. Claude Code and Codex put MCP
  instructions into the model's context (measured); OpenCode and Grok also get the text in their
  system prompt.
- **OS down is not "no tools".** `initialize` is answered locally, `tools/list` answers from the
  last list the box saw, and a call returns a plain `os_unreachable` error. The thread gets one
  notice line; the daemon retries the connections fetch in the background.
- OS's `systemPrompt` is appended to every thread's system prompt, with one line that names the
  company-system servers. `needsConsent`, `profile` and reachability are at
  `GET /api/os/connections` (owner); `POST /api/os/connections/refresh` asks OS again;
  `GET /api/os/tools` is OS's tool list (with each tool's `server` and `tool`).
