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
# forceLoginMethod is intentionally omitted until the accepted value string is
# confirmed against the CLI (Phase 0 item). Writing a wrong value here would block
# login entirely — the same failure class as forceLoginOrgUUID. Add it once verified.
RUN mkdir -p /etc/claude-code && printf '%s\n' '{}' > /etc/claude-code/managed-settings.json

ENV SHELL=/bin/bash \
    PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:/home/dispatch/.local/bin:$PATH \
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
# Installed as the `dispatch` user so they land in that user's $HOME and are owned
# by the account that will actually run them.
USER dispatch
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN npm config set prefix /home/dispatch/.local && npm install -g @openai/codex

USER root
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
