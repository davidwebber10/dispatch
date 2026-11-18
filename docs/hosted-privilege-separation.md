# Hosted boxes: privilege separation

Status: built, and proven in a locally built image (section 13). Not yet run on the real platform
(section 10 lists what must be checked there). Capability: `privsep-v1`. Hosted mode only: a local
install is unchanged, and with `DISPATCH_PRIVSEP` unset none of this code changes anything.

## 1. The problem

A hosted box is one container per person. It runs the daemon and everything the daemon starts: agent
harnesses, developer shells, tool bridges, plugin workers. Before this work all of them ran as one
operating-system user. An agent reads untrusted text and has a shell, so it must be treated as
hostile. With one user, a hostile agent could read the daemon's credentials, change the daemon's
state, and call the daemon or the platform with the owner's authority. Every control the daemon
enforces (approvals, the business profile, per-thread tool scoping) then rested on nothing the agent
could not undo.

Goal: the daemon is a trusted supervisor. Every process it starts is an untrusted workload. A
workload cannot read the daemon's secrets, cannot change the daemon's state, and cannot speak to the
daemon or to the platform with the owner's authority. Threads, files, sign-ins, resume after a
restart, terminals and the headless API keep working.

## 2. Threat model

- Attacker: code that runs as a workload (any thread, shell, MCP bridge, plugin worker, or a child
  of one). It can run arbitrary programs, compile code, open sockets, and read everything its user
  may read.
- Trusted: the kernel, the container runtime, the image, the entrypoint, the daemon process.
- The platform is trusted. The network path to it is not assumed private (section 9).
- Out of scope here: the network egress allow-list, the route gate of the business profile, the file
  routes, the managed harness policy. Other work covers those; this design depends on them where
  section 10 says so.

## 3. Decisions (short form)

| # | Decision | Reason |
| --- | --- | --- |
| D1 | Two identities: the daemon runs as `root` with a reduced capability set; every workload runs as the unprivileged user `dispatch` (uid 1000). | The kernel then enforces the boundary: a different uid cannot read `/proc/<pid>/environ`, attach a debugger, send a signal, or open a file that the mode bits deny. |
| D2 | One agent uid for all threads of a box. | The person's home is one identity on the shared file system (section 8), so per-thread uids would isolate nothing that matters, and they would multiply the moving parts. Threads of one box are NOT isolated from each other. |
| D3 | The uid switch is done in the forked child by the runtime's own `setgid`/`setuid` calls (the `uid`/`gid` spawn options of Node and of the PTY library). No helper binary, no `sudo`, no file capabilities, no ambient capabilities. | Zero added privileged code. A root process that changes all its uids to non-zero loses every capability in the kernel, so the child cannot keep any. |
| D4 | One chokepoint makes EVERY child process a workload. It is installed before any other module loads, it has no opt-out, and the daemon proves it at start. | A missed call site would run a child as the daemon user. Default deny is the only safe shape with about 40 spawn sites. |
| D5 | The daemon sets `no_new_privs` and a small capability bounding set on itself before it starts. Both are inherited by every workload. | A workload can never gain privilege through a set-uid program or a file capability, whatever is in the image. |
| D6 | The two tokens reach the daemon through a pipe, live only in its memory, and are absent from every environment that a workload could read. | `/proc/<pid>/environ` of another uid is not readable, and the daemon's own environment no longer holds them at all. |
| D7 | The inbound token (router to box) and the outbound token (box to platform) are different values. Each side stores in clear only the one it must present. | A leak of one direction does not give the other. |
| D8 | Owner authority is never accepted from a local peer (loopback or the box's own addresses). A local caller is a key principal or nothing. | Even a leaked inbound token is useless from inside the box. |
| D9 | Daemon state moves out of the person's home to a directory that the agent user cannot traverse. Files that a workload must read are written to a separate root-owned directory; files that a workload must write stay in the home. | Default private: a path that nobody converted is unreadable to a workload (it fails closed, and it shows in testing). |
| D10 | Everything in the person's home is untrusted input to the daemon, and the daemon changes nothing below the home with its own rights: every write, folder, rename and removal there runs as the agent user. | The agent owns the home and can swap any folder in it for a link at any moment. A root process that writes there can be led anywhere; a check before the write does not close the race. |
| D11 | The home keeps an access point with an enforced POSIX user (the agent uid). Daemon state gets a second access point, mounted below a local root-only directory. Each box has its own IAM role that may mount only its own two access points, and the file system refuses every client that does not use IAM, TLS and an access point. | Section 8. |
| D12 | The image reports `privsep-v1` only when a self-check, run as the agent user at start, fails every access it should fail. The platform refuses a business person on a box without it. | The Fargate-dependent assumptions are verified on every start, on the real platform. |

## 4. Identities and process control (question 1)

### Who runs as what

| Process | User | Notes |
| --- | --- | --- |
| init (PID 1), entrypoint | root | The entrypoint prepares directories, then replaces itself with the daemon. |
| daemon (Node) | root, capabilities bounded to `CHOWN DAC_OVERRIDE FOWNER SETGID SETUID KILL`, `no_new_privs` set, no supplementary groups | Holds the secrets and the state. |
| agent harness (Claude Code, Codex, OpenCode, Grok), structured or PTY | dispatch (1000) | |
| developer shell (PTY) | dispatch (1000) | |
| MCP servers and bridges (started by a harness) | dispatch (1000) | Children of a workload. |
| plugin workers, plugin hooks | dispatch (1000) | |
| every helper the daemon runs (`git`, `ps`, sign-in CLIs, thumbnailers, probes) | dispatch (1000) | They read content the agent controls (a repository's config can run code), so they are workloads too. |

### Why the daemon is root and not a third unprivileged user

The daemon must read and write the person's files whatever their mode bits are (harnesses create
`0600` files and `0700` directories), must create files there that the agent owns, must signal
workloads, and must start processes as another user. On an ordinary file system that set of needs is
`DAC_OVERRIDE + CHOWN + FOWNER + KILL + SETUID + SETGID`, which is root in all but name. Three
alternatives were compared:

- **A set-uid helper restricted to a daemon group** (the daemon unprivileged). Adds privileged C
  code, needs set-uid execution to work on the platform, and leaves the file-access problem: every
  daemon read or write under the home would have to go through the helper. Large change, new code
  with root rights.
- **`sudo` with one rule.** A large set-uid program with a long defect history, for one fixed rule.
- **File or ambient capabilities on the daemon.** Ambient capabilities are inherited by children
  across `exec` unless every spawn goes through a wrapper that drops them; a missed site would hand a
  workload `CAP_SETUID`. File capabilities depend on extended attributes surviving the image store.

Chosen: root with a bounded set (D1, D3, D5). The trusted code is what was already trusted with the
secrets (the daemon) plus nothing. What it costs: a code-execution defect in the daemon is root in
the container. There is no asset in the container beyond what the daemon already holds, the
container is unprivileged, and the read-only root file system (section 9) removes the image as a
target. A later step can move the daemon to its own uid behind a file broker; the boundary of this
design does not change when that happens.

### How a workload starts

`privsep/spawn-guard.ts` replaces the process-creation entry points of `child_process`
(`ChildProcess.prototype.spawn`, which `spawn`, `exec`, `execFile` and `fork` all use, and the three
synchronous functions) and wraps the PTY library (`spawn` and its two older names, `fork` and
`createTerminal`). Each call gets `uid` and `gid` of the agent user,
and the environment is filtered (section 5). There is no option to
start a child as the daemon user. In the forked child the runtime calls `setgroups(0)`, `setgid`,
`setuid` and then `exec`. The kernel clears the permitted, effective and ambient capability sets on
that uid change. `no_new_privs` and the bounding set are inherited.

At start the daemon runs `id -u` through every entry point (asynchronous, synchronous, each PTY name)
and refuses to start when any answer is not the agent uid.

The guard changes the two modules, not their callers, so a new call site in any file is covered. What
it cannot cover is another way to run code: a worker thread or the `vm` module (both run inside the
daemon, as the daemon's user), a native add-on, the PTY library's native binding. A test
(`tests/privsep/spawn-sites.test.ts`) keeps the list of files that can start a process, refuses
every such other way in the daemon's source, and fails when the runtime or the PTY library gains a
process-creating export that the guard does not replace.

### The PATH

On a box with privilege separation the daemon keeps the PATH the image gave the container. A local
install asks a login shell for its PATH; on a box that shell would read `~/.profile` and `~/.bashrc`,
which are the agent's. A workload could then put its own `claude` or `git` in front of the image's
for every later thread, and have its commands run at each start of the daemon. No login shell is
asked. (A developer's terminal thread is itself a login shell of the agent; that is the agent's own.)

### Terminals

A developer shell is a PTY whose child runs as the agent user. The daemon holds the master side. The
slave device is owned by the agent user after the spawn, so programs that reopen their terminal by
path work.

### Signals and lifecycle

The daemon keeps `CAP_KILL`, so stopping, restarting and the kill-after-grace of a thread work as
before, including process groups. A workload cannot signal the daemon (different uid, no
capability). When the daemon exits, the container exits; no workload outlives it.

### What a workload sees of other processes

`/proc` is not mounted with `hidepid` (not available to a task), so a workload sees that the daemon
exists, its pid and its command line. The command line holds no secret. The environment, memory,
open files and working directory of the daemon are not readable (they need the same uid or
`CAP_SYS_PTRACE`).

## 5. Secrets (question 2)

Two tokens exist on a box:

- **Inbound**: the router and the control plane send it to the box. The box only verifies it.
- **Outbound**: the box sends it to the platform. Only the daemon holds it.

Delivery at start:

1. The task definition carries them as environment variables of the container.
2. The entrypoint (root) reads them, writes them into a pipe, and starts the daemon with that pipe as
   an inherited descriptor and with the variables removed from the daemon's environment.
3. The daemon reads the pipe once and closes it (`privsep/secrets.ts`), and the holder of the two
   secrets (`platform/box-secrets.ts`) keeps the values in memory. Nothing is written to a file
   system, and the environment block that `/proc/<pid>/environ` shows never held them.
4. PID 1 (the init process) still has the original environment. It runs as root, so a workload
   cannot read it.

The daemon also removes from its own environment, and the chokepoint removes from every child
environment: the token variables, the descriptor variable, and the variables that locate the task's
cloud credentials and task metadata. A workload therefore starts without the address of the
credential endpoint (section 9 lists what that does and does not give).

Reaching platform tools: a workload calls the daemon's loopback route with its **thread key** (a
random value the daemon mints at spawn, bound to one thread, held as a hash, revoked when the thread
ends). The daemon checks the key, applies the thread's system filter, and forwards to the platform
with the outbound token, the owner and the thread id. What a stolen thread key allows is the route
table of section 6 and nothing else.

## 6. The daemon's API from inside the box (question 3)

- The owner credential (the inbound token header) is accepted only from a peer that is not local.
  A peer is local when its address is a loopback address or one of the box's own interface
  addresses. The decision uses the socket's address, never a forwarded header. This holds for HTTP
  and for WebSocket upgrades.
- The owner access-token file of a local install is not created and not accepted on a separated box.
  The `dispatch` command line in a developer's shell on the box therefore has no owner authority
  either: a shell in the box is a workload like any other.
- A request with no credential is refused (the box gate, unchanged).
- A WebSocket upgrade with a key is refused (unchanged), so a workload cannot open a terminal or a
  structured socket.
- A workload therefore authenticates only as a key principal. Routes are owner-only by default; a
  key reaches a route only through an explicit rule. What agents need, and get:

| Principal | May do |
| --- | --- |
| thread key | report its own status and hook events; read its own project's threads and conversations; read and answer questions within the rules of its project (never allow a held tool call of its own); message and start threads in its project within the depth and rate limits, with the daemon writing the identity fields; watches; ledger entries of its project; call the company-tools route for the systems its thread may use; ask the owner to sign in |
| shell key | ask the owner to sign in; nothing else |
| chat key | the memory and ledger routes of the chat; act on threads the chat started |
| plugin key | the routes its manifest permissions name |

  Routes that change what a later thread runs (integrations, schedules, roles, plugins, skills) stay
  subject to the profile gate: a business profile refuses them for every principal.
- The router-facing port stays reachable from the network and still needs the inbound token.
- Routes added later follow the same two rules without any work of their own, because both rules sit
  in front of the routes: the owner credential is refused from a local peer at the gate, and a route
  with no key rule is the owner's. So the Inbox routes (`/api/inbox…`) and the connections refresh
  (`POST /api/os/connections/refresh`) answer 401 or 403 to everything inside the box. The event
  stream of a company system (`GET /api/os/mcp/<system>`) is a thread's: a thread key on loopback
  opens it, and only for a system the platform named for the person (inside the thread's own limit
  when it has one).
- The Inbox. An agent hands the person a file or a text with the tool of the bundled Inbox plugin.
  That tool runs under the thread's own key and uses the plugin's storage routes, which the plugin
  grants to threads: `POST /api/plugins/previews/files` and `PUT /api/plugins/previews/data/<key>`.
  The bytes of a drop's file go to the owner only (the plugin's file route and the Inbox file route
  have no key rule). A thread's key CAN list the documents in the plugin's storage, so it can read
  the title and text of another thread's drop: threads of one box are not isolated (D2). The value of
  a `secret` drop is never read back under the business profile, by any principal.

## 7. State (question 4)

### Three roots

| Root | Path on a box | Owner, mode | Holds |
| --- | --- | --- | --- |
| state | `/var/lib/dispatch/state`, below `/var/lib/dispatch` (root, `0700`) | root, `0700` | the database, settings files, accounts list, plugins and their registry files, skills, logs, pid and listen files, everything not listed below |
| agent run dir | `/run/dispatch/agent` | root; folders `0750` and files `0640`, group of the agent | what the daemon generates for a workload to READ: thread and plugin key files, MCP config files, prompt files, hook settings, per-thread OpenCode config, the browser shim, preload scripts. Emptied at each start. One sub-folder (`rw/`) belongs to the agent, for sockets. |
| daemon scratch | `/run/dispatch/private` | root, `0700` | uploads in transit |
| agent data dir | `$HOME/.dispatch` | dispatch | what a harness must WRITE and keep: per-account config dirs of the harnesses, the chat working folder |

`platform.dataDir()` returns the state root on a box. A path that nobody moved is therefore private.
A workload that needs a file the daemon forgot to publish gets a permission error, not a secret.

### The daemon treats the home as untrusted

The daemon parses transcripts, lists skills, reads project files and harness config. All of it is
data, never authority:

- The file routes serve the person's own folders only (the path policy of the file routes); the
  state root and the agent run dir are outside them. The agent data dir (`~/.dispatch`) is in the
  home, and it holds the account folders of the harnesses with their sign-in files; the path policy
  refuses it by name (`agentDataDir` in `files/path-policy.ts`), as it did when that folder was the
  data folder. Without that rule the move of the state would have opened those files to the file
  routes.
- The daemon makes no change below the home with its own rights (`privsep/agent-fs.ts`). A file
  write, an upload, a new folder, a rename, a removal, a new project folder, a harness account
  folder: each runs as one small script under the agent's uid, so the kernel applies the agent's
  rights to every part of the path. A link a workload planted leads only where that workload could
  already go. The daemon changes an owner at exactly two fixed paths, at start, before any workload
  runs (the home and the agent data dir in it), and never follows a link there.
- No setting that the daemon acts on is read from the home on a box.

Reads are different: the daemon reads transcripts and project files with its own rights. What it
reads is shown to the owner or parsed as data; the state root holds no secret (section 5), and the
file routes refuse a path outside the person's folders after resolving it.

One read is NOT made with the daemon's rights: the copy of a file that a thread posts (a drop for the
Inbox, any plugin file). The daemon keeps that copy in its own state
(`<state>/plugin-files/<plugin>/<file id><ext>`, root, `0600`, in a `0700` folder) and serves it later
by id through an owner route. A workload chooses the path and can swap a folder of it for a link
between the daemon's check and its read, so a read with root rights could put a file of the daemon
into a copy. The bytes are therefore read AS THE AGENT (`agentReadFile` in `privsep/agent-fs.ts`: one
small process under the agent's uid opens the path without following a link at its end, checks on the
open file that it is a regular file within the size limit, and sends the bytes back on a pipe). The
kernel applies the agent's rights to every part of the path, so the copy can hold only what the agent
could read itself. A posted file that got no copy (too large, or the read was refused) is served from
the project the same way, as the agent.

### What persists in agent-writable files (prompt-injection persistence)

One agent uid means a thread can write any file a later thread reads. The table says which files are
locked and which are accepted.

| File | Effect on a later thread | Status |
| --- | --- | --- |
| Harness managed policy (`/etc/claude-code/managed-settings.json`) | highest-precedence settings | Locked: root-owned, in the image or written by the entrypoint. The agent cannot change it. Which keys it sets (bypass mode off, hooks and permission rules from the managed file only) is owned by the harness-policy work. |
| User settings, hooks, skills, commands, agents, memory files, MCP config under the harness config dir and in projects | run in every later thread of this person, as the agent user, within that thread's approvals | Accepted risk for hooks/skills/memory when the managed policy does not disable them; they never run as the daemon and never hold a daemon credential. Listed in section 11. |
| Transcripts | resumed by a later turn | Accepted: same thread, same rights. |
| Files the daemon generates per spawn (MCP config, prompt file, hook settings, key file) | decide what a thread is told and which servers it gets | Locked: root-owned in the agent run dir, rebuilt at each spawn. |
| Daemon database, settings, approvals, schedules, thread registry, integrations | everything | Locked: state root. |
| Plugins: code and manifest | a manifest grants API permissions to the plugin's key | Locked: state root. (A consequence: the worker of an INSTALLED plugin cannot read its own code on a separated box yet; see section 12. Plugins that ship in the image work.) |

## 8. Credentials of the person's AI accounts (question 5)

A harness must read its own sign-in file, so the agent user can read it. This is stated plainly: a
hostile thread can read and use the person's Claude and Codex credentials. Compensating controls,
none of them in this change: the egress allow-list (the credential cannot be sent to an arbitrary
host), and revocation on the provider's side. Several accounts of one person: all their config dirs
belong to the same agent user. Isolation between a person's own accounts is NOT a product promise;
per-account uids were considered and rejected for the same reason as per-thread uids (D2).

## 9. The persistent home and the file system (question 6)

### Facts

- The platform creates one access point per box with an enforced POSIX user (1000:1000) and a root
  directory of its own. With enforcement, the file system treats every client process as that one
  user, whatever its local uid. Mode bits cannot tell two local users apart on that mount.
- The file system had no file-system policy, the task mounted without IAM authorization, and the NFS
  port is reachable from every box. A process in a box can speak NFS itself; it needs no mount
  privilege. Access points alone therefore did not isolate boxes.

### Choices

- **Home**: keeps the enforced access point. This is a feature here: the daemon (root) and the agent
  both act as uid 1000 on it, the daemon reads every file, what it creates belongs to the agent, and
  an existing box needs no ownership change on the shared file system.
- **Daemon state**: a second access point per box, root directory outside every home, enforced user
  990:990 (an id no process in the box runs as), mounted at `/var/lib/dispatch/state`. Because enforcement makes mode bits meaningless,
  protection inside the box comes from the parent directory `/var/lib/dispatch`, which is on the
  container's own file system, owned by root, mode `0700`. A process of another uid cannot walk
  through it, and has no other way to name the mount (no descriptor is inherited, `/proc/<pid>/cwd`
  and `/proc/<pid>/root` of the daemon need the daemon's uid).
- **Secrets** never go to either mount (section 5).
- Rejected: an access point without an enforced user for the state (real uids on the server; it
  needs root access for the daemon and gives nothing the local directory does not); state on the
  task's own disk with a backup to the shared file system (the backup has the same exposure, and a
  crash loses turns).

### Between boxes

- A file-system policy denies every client that does not use TLS, a mount target and an access
  point, and denies root access to everyone. In its first level an anonymous client may still mount
  through an access point (so a box on an older task definition keeps its home); in its second
  level, set when every box was rebuilt, no anonymous client is admitted at all.
- Each box has its own IAM role, created by the provisioner under a fixed path with a permissions
  boundary. The role's only file-system permission is mount and write through that box's two access
  points. The volumes of the task use IAM authorization and transit encryption.
- Compared: one shared role (a box could mount any access point: no isolation); a per-task principal
  tag matched against an access-point tag (the task credentials carry no per-task tag that the
  documentation states, so it is not usable); one file system per person (one mount target per zone
  each, a hard limit of mount targets per network, slower provisioning). Limits of the chosen
  option: 10,000 access points per file system (two per box), IAM roles per account (one per box;
  the default quota is 1,000 and can be raised).

### What an agent that holds the task role's credentials can do

The daemon hides the address of the credential endpoint from workloads, and that address contains a
random identifier. If an agent obtains the role's credentials anyway, it can open an authenticated
NFS session of its own, as any uid, to **its own box's** two access points: its home (which it
already controls) and its own box's daemon state (database and settings; no token is stored there).
It cannot reach another box. It also gets the role's other permissions, which today are the control
channel of the operator's debug session only. This is why secrets stay in memory, and why decisions
that matter are taken from the live profile and the image's policy, not only from stored state.

### Migration of an existing box

On the first start of the new image the daemon (root), before it opens the database:

1. If the state root holds the marker `migrated-from-home`, go to step 4.
2. If `DISPATCH_MIGRATE_LEGACY_HOME=1` (the platform sets it until the box has reported `privsep-v1`
   once), `$HOME/.dispatch/dispatch.db` exists and the state root holds no database yet: copy the
   private entries of the old data directory into `state/.incoming`, then rename each into place, the
   database last. An interrupted copy is discarded and repeated; the source is not touched until the
   end. Symbolic links are not copied, at any depth.
3. Write the marker (also on a box with no old state). Without the platform's flag an old data
   directory is left exactly as it is, and no marker is written: nothing is deleted that was not
   copied.
4. Remove the private entries (database, token files, registry files, key files) from
   `$HOME/.dispatch`. Idempotent; safe to interrupt. The harness folders stay.
5. Give `$HOME` and `$HOME/.dispatch` to the agent user (a no-op on the enforced mount).

The old database was writable by the old agent, so this one import trusts it once. A database that
appears in the home later is never imported: the marker lives in the state root. Going back to an
older image afterwards does NOT bring the state back into the home: keep the storage backup.

## 10. Kernel and resource controls on Fargate (question 7)

| Control | Use |
| --- | --- |
| Start as root | The image's default user is the agent user. Privilege separation needs the container to START as root (`user: "0"` in the task definition) and a volume at the state root; otherwise the entrypoint runs everything as one user, as before, and the box does not report `privsep-v1`. |
| `no_new_privs` | Set by the entrypoint on the daemon; inherited by all workloads. |
| Capabilities | Bounding set of six for the daemon; workloads have none. The task definition also drops what the container never needs. Fargate allows adding only `SYS_PTRACE`; nothing is added. |
| Set-uid programs | The image has none; with `no_new_privs` they would be inert anyway. |
| Read-only root file system | Supported and used in the proof. The writable places are the two mounts, `/tmp` and `/run/dispatch` (both declared volumes of the image; `tmpfs` mounts are not available to a task). The platform sets it with a switch, after one clean start. |
| User namespaces | A user namespace is NOT harmless. In one of its own a workload mounts an empty folder over `/etc/claude-code`, and a nested harness then runs with no managed policy (no approval lock, no MCP allow-list, no connector or Artifact switch); this was shown with the real Claude Code in a container without a seccomp filter. The sysctl `user.max_user_namespaces` cannot be set on Fargate. The runtime's default seccomp filter refuses `unshare` and `clone(CLONE_NEWUSER)` to a process without `CAP_SYS_ADMIN` (shown locally with `--security-opt seccomp=builtin`). That the platform's filter does the same must be MEASURED on a stage box: `unshare -Ur true` as uid 1000 must fail. The start-up self-check makes this measurement on every start (check `userns`): when a namespace can be made, the box does not report `privsep-v1`, so the platform gives it no business person. |
| seccomp | The platform's default filter is active (measured). Custom profiles are not available. |
| pid and memory limits per workload | cgroups are not delegated to a task. Available: `ulimit` values in the task definition (`nofile`, `nproc`) and the daemon's own caps on live threads. A workload can exhaust the task's memory; the task then restarts. Stated as not protected. |
| `/proc` | No `hidepid`. Other users' pids and command lines are visible; their environment and memory are not. |
| Cloud credential endpoint | Reachable by any process that knows the path. The path is hidden from workloads (section 5). The role is minimal (section 9). |

Assumptions that the start-up self-check verifies on the real platform (run as the agent user; the
capability is not reported when one fails): the state root and its parent cannot be listed, read or
written; the secrets are in no readable environment; the daemon's environment, memory, open files
and working directory cannot be read; the daemon cannot be signalled; `no_new_privs` is 1 and the
capability sets of a workload are empty; a set-uid program does not raise privilege; the agent run
dir is readable and not writable; a user namespace cannot be made (`unshare -Ur true`).

Assumptions it cannot verify, to be measured once on the real platform: a volume mounted at the state
root leaves the mode of the parent folder as the image made it (the entrypoint refuses to start
otherwise); IAM authorization of two access points with one task role; that the path of the task
credential endpoint cannot be learned by a workload; `fs.protected_symlinks`.

## 11. Two tokens end to end (question 8)

| | Inbound (router to box) | Outbound (box to platform) |
| --- | --- | --- |
| Minted by | the platform, at each task-definition registration | the platform, at each task-definition registration |
| Platform stores | clear (the router must send it) | SHA-256 only (the platform only verifies) |
| Box holds | in the daemon's memory | in the daemon's memory |
| Who presents it | router, control plane | daemon |
| Rotation | on every rebuild; the previous value is not accepted after the new task is ready | on every rebuild; the previous hash is accepted until the new task is ready, so the old task's last calls do not fail |

- The router asks the platform for the box of the signed-in person and receives the inbound token.
  It never sees the outbound token.
- The platform's box-facing routes accept only the outbound token. During migration they also accept
  a legacy single token of a box that has not been rebuilt.
- Compatibility: an older image receives two different values in the same two variables and works.
  A box row that still has one value keeps working until its next rebuild.
- The image reports `privsep-v1`. The platform refuses to open a box for a business person when the
  box does not report it, and the box-facing tool gateway refuses a business person's box without it.

## 12. What is NOT protected after this work (question 9)

- While a thread runs, the agent can use the person's AI account credentials, and can read them.
- The agent can read and change everything in the person's home and projects, including the config,
  hooks, skills and memory files of the harnesses that later threads load (unless the managed policy
  disables them).
- A thread can call every tool that its thread is allowed to call, and can do everything its thread
  key allows on the daemon.
- Threads of one box are not isolated from each other.
- The agent can reach whatever the network lets it reach (until the egress allow-list ships), and
  the platform's internal endpoint. The outbound token is not available to it; the path to the
  platform should be TLS and source-restricted, and this design does not depend on that.
- Approvals that a harness enforces inside its own process are advisory against an agent with a
  shell: it can start another harness process. The managed policy narrows this; it is not closed
  here.
- A workload can exhaust CPU, memory, pids or disk of its own box.
- A defect in the daemon that executes code gives root in the container.
- Not working on a separated box yet (each fails closed): the worker of an installed plugin (its code
  is in the state root); the Doppler secrets MCP server (its config is in the state root); per-thread
  Grok homes (a Grok thread runs without the injected servers and hooks); the in-app CLI installer
  (the image's CLIs are used). Skills installed from a marketplace were not exercised.
- Working on a separated box, and in the proof: the Inbox (the bundled plugin `previews`). Its MCP
  server is code of the image (`/app/packages/plugins`, readable by the agent), it runs as a child of
  the harness with the thread's key, and it needs only the daemon's routes. Small copies of images
  (thumbnails) are not made on a box: the image has no resizer; the original is served.
- A thread can read the title and text of another thread's Inbox drop through the plugin's storage
  route, and under the developer profile the value of a `secret` drop too (section 6). The files of a
  drop, and under the business profile a secret's value, go to the owner only.
- Proven only with a stand-in for the Claude CLI. The real Claude, Codex, OpenCode and Grok CLIs and
  the real sign-in flows were not run under the two-user layout.
- If an agent obtains the task role's credentials, it can read and change its own box's daemon state
  through a session of its own (section 9).
- The tokens are clear text in the task definition and in the init process's environment (root
  only). Moving them to a secret store is separate work.

## 13. How this is proven

`docker/hosted/privsep-proof/run-proof.sh` starts one box from a locally built image (started as
root, read-only root file system, a volume for the home and one for the state), a stand-in for the
platform and a stand-in for the Claude CLI. It prints:

- what works: start and self-check with the capabilities the platform's task definition leaves, the
  capability list, the platform's two readiness calls, a chat thread, a developer terminal, files in
  both directions, the sign-in state, the process table, a planted link that cannot redirect the
  owner's actions;
- the Inbox, end to end, under both profiles: a thread's harness starts an MCP client
  (`agent-work.mjs`) with the harness's own arguments and key; it starts the Inbox server from the
  thread's MCP config and sends a CSV file and a secret; the owner route lists the drop and serves
  the file byte for byte; the thread's own key gets 403 on the owner routes and on the file;
- live tools: a system that is not connected has a server with the one tool `connect`; the person
  connects it on the stand-in platform; `list_changed` reaches the harness's client on the event
  stream and through the stdio bridge; the same thread then lists the real tools;
- the attack list, run AS A WORKLOAD: once in a developer shell the daemon started, once by the
  harness process itself under the business profile. Every attempt must fail. `attack.sh`: identity,
  the tokens, the state, the files the daemon writes for workloads, the managed policy files and the
  harness programs, signals, the API with every credential a workload can collect, the platform
  directly, persistence. `attack-routes.mjs`: the Inbox routes and the connections refresh with every
  credential at loopback, `::1` and the box's own address; the event stream of a system the thread
  was not given; a hunt for the token values and for a secret drop's value in every answer a key can
  get; a link, a linked folder and a folder swapped for a link DURING the daemon's read of a posted
  file (the proof script then reads every copy the daemon kept, from outside the box); twenty
  spellings of each new path. `nested-harness.sh`, in a box with the image's real harness programs:
  a second Claude Code and a second Codex with each flag that asks to skip approvals;
- restart: threads, history, the Inbox and sign-in state survive; a `claude` that a workload put on
  the login PATH before the restart is not the harness of a thread after it, and the daemon's start
  ran no start file of the home;
- the same image on the task definition the platform writes today (no user, one volume, ONE token
  value): it starts as one user and does not report `privsep-v1`; and separated with one token value;
- an existing box: a home made by an image from before this work is imported on the first start.

The run of 2026-11-12 on the image `4.6.0-os.5` (the branch with the hardening work merged in, a
read-only root file system, the seven capabilities dropped that the platform's task definition
drops): 80 of 80 functional checks; 599 attacks stopped and none not stopped from a developer shell;
602 and none from a business-profile harness process; 8 and none for a nested harness with the
image's real programs (each flag that asks to skip approvals: Claude Code reports permission mode
`default`, Codex reports approval `untrusted` and sandbox `read-only`).

`docker exec` is not used to run the attacks: it makes a process the daemon never started, with the
container's own environment. The unit tests (`tests/privsep/`) cover the chokepoint, the secrets
hand-over, the path roots, the agent-side file operations, the local-peer rule, the migration and
the self-check.
