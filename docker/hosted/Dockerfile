# Hosted Dispatch box — one container per user, run on ECS Fargate (Graviton/arm64).
#
# This is NOT how Dispatch is installed locally (that's launchd via `dispatch install`).
# Here the container IS the daemon: PID 1 runs the server directly, so none of the
# platform daemon-controller code is used — which is why `platform/linux.ts` throwing
# on install/start/stop doesn't matter in this deployment.
#
# Design notes that are easy to get wrong:
#   • SHELL=/bin/bash — platform/darwin.ts's resolveLoginPath() (inherited by linux)
#     runs `$SHELL -ilc`, defaulting to /bin/zsh which doesn't exist here. Unset SHELL
#     means spawned agents get an unresolved PATH.
#   • The workspace-root postinstall (scripts/fix-node-pty-perms.mjs) restores the
#     exec bit on node-pty's spawn-helper. Without it every pty.spawn() fails.
#   • claude is installed via the native installer (a standalone binary, no Node at
#     runtime) so it is not coupled to this image's Node version.
#   • NO ANTHROPIC_API_KEY / OPENAI_API_KEY may reach this image. Auth precedence puts
#     an API key ABOVE the user's subscription login, so a stray key would silently
#     override every user's own account. Asserted at startup by entrypoint.sh.
#   • managed-settings.json deliberately does NOT set forceLoginOrgUUID: the estate is
#     mixed (Team seats + individual Max), and Claude Code exits at startup when the
#     credential belongs to a different org. See docs §3.3.1 in the OS design doc.
#
# Single-stage on purpose for the spike: pnpm's symlinked store makes copying
# node_modules across stages fragile, and image size doesn't matter yet. Slim it later.

FROM node:22-bookworm-slim

# --- OS packages -----------------------------------------------------------
#   build-essential/python3 : node-gyp fallback if a native prebuild is missing
#   ripgrep                 : Claude Code's search tool (avoids USE_BUILTIN_RIPGREP juggling)
#   git/curl/ca-certificates: agent workflows + the claude installer
#   procps                  : platform.listProcessIds() shells out to `ps`
#   less                    : pagers used by git and the CLIs
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 git curl ca-certificates ripgrep procps less unzip \
    && rm -rf /var/lib/apt/lists/*

# --- Non-root user; $HOME is the EFS mount point in production --------------
# uid/gid 1000 must match the EFS access point's POSIX owner. The node base image
# already ships a `node` user at 1000:1000, so rename it rather than creating a
# second account (a fresh useradd -u 1000 fails: "GID '1000' already exists").
RUN groupmod -n dispatch node \
    && usermod -l dispatch -d /home/dispatch -m -s /bin/bash node

# --- Claude Code managed settings (highest-precedence scope) ---------------
# forceLoginMethod=claudeai (accepted values verified against the binary:
# claudeai | console | gateway). Two jobs:
#   1. It pins auth to the claude.ai subscription path, blocking Console logins and
#      ANTHROPIC_API_KEY / apiKeyHelper credentials — a second guard against the
#      stray-API-key failure the entrypoint also checks for.
#   2. It makes `claude setup-token` skip the login-method chooser, which is what
#      lets the terminal-free login (auth/claude-login.ts) reach the OAuth URL with
#      ZERO keystrokes instead of puppeting a TUI.
#
# forceLoginOrgUUID is deliberately NOT set: the estate mixes Team seats with
# individual Max subscriptions, and Claude Code EXITS AT STARTUP when the active
# credential belongs to a different org — which would lock every Max user out of a
# box that otherwise looks healthy.
RUN mkdir -p /etc/claude-code \
    && printf '%s\n' '{"forceLoginMethod":"claudeai"}' > /etc/claude-code/managed-settings.json

# AGENT_HOME is where the agent CLI *binaries* live. It must be OUTSIDE $HOME:
# in production /home/dispatch is an EFS mount, and mounting it shadows anything
# the image installed under it (observed in Phase 0 as `claude=MISSING`). The split
# is deliberate and correct — binaries are fleet-wide and versioned with the image;
# only per-user state (~/.claude credentials, ~/.codex, repos) belongs on EFS.
#
# DISABLE_AUTOUPDATER follows from that: AGENT_HOME is root-owned, so the runtime
# user can't self-update anyway, and a fleet should move versions by redeploying a
# known image rather than 52 boxes drifting independently.
ENV SHELL=/bin/bash \
    PNPM_HOME=/usr/local/pnpm \
    AGENT_HOME=/opt/agents \
    PATH=/usr/local/pnpm:/opt/agents/.local/bin:/usr/local/bin:$PATH \
    DISABLE_AUTOUPDATER=1 \
    NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@11.5.2 --activate

# --- Dispatch source + build ----------------------------------------------
WORKDIR /app
COPY --chown=dispatch:dispatch . .

# Dev-only dependencies are needed to BUILD (tsc, vite), so install the full tree.
# NODE_ENV=production would make pnpm skip devDependencies, so override for install.
RUN NODE_ENV=development pnpm install --frozen-lockfile \
    && NODE_ENV=development pnpm -r run build

# --- Agent CLIs ------------------------------------------------------------
# Installed into AGENT_HOME (/opt/agents), NOT the runtime user's $HOME, because
# $HOME is an EFS mount in production and would shadow them. The installer honours
# $HOME, so override it for the install step only. Binaries stay root-owned and
# world-executable: shared, immutable, versioned with the image.
RUN HOME=/opt/agents bash -c 'mkdir -p /opt/agents && curl -fsSL https://claude.ai/install.sh | bash' \
    && chmod -R a+rX /opt/agents \
    && ln -sf /opt/agents/.local/bin/claude /usr/local/bin/claude \
    && printf '%s\n' 'export PATH="/opt/agents/.local/bin:$PATH"' > /etc/profile.d/agent-clis.sh
# codex, plus mcp-remote: IntegrationsService spawns REMOTE MCP servers as
# `npx -y mcp-remote <url>`, which on a box means an npm fetch on every single spawn.
# Baking it in makes spawns faster and removes a network dependency from the path
# that attaches a user's tools.
RUN npm install -g @openai/codex mcp-remote

# Verify the CLIs resolve **on a LOGIN shell's PATH**, not just this build shell.
# That distinction is the whole point: startServer() replaces process.env.PATH with
# platform.resolveLoginPath() (a macOS launchd fix), so anything reachable only via
# a Docker ENV PATH disappears for the daemon and everything it spawns. /opt/agents
# is exactly that case, which is why the symlink into /usr/local/bin above exists.
# Asserting with `bash -lc` is what makes this class of bug fail the build instead
# of surfacing as "command not found" inside a user's first thread.
RUN bash -lc 'command -v claude && command -v codex && command -v mcp-remote && claude --version'

RUN chown -R dispatch:dispatch /app
COPY --chown=dispatch:dispatch docker/hosted/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER dispatch
WORKDIR /home/dispatch
EXPOSE 3456

# DISPATCH_WEB_DIST is set explicitly because the server's fallback resolves relative
# to its own dist/ location, and we run with a different CWD than the repo root.
ENV DISPATCH_WEB_DIST=/app/packages/web/dist \
    PORT=3456

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
