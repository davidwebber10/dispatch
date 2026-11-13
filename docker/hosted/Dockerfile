# syntax=docker/dockerfile:1
# Hosted Dispatch box — one container per person, run on ECS Fargate (Graviton/arm64).
#
# This is NOT how Dispatch is installed locally (that's launchd via `dispatch install`).
# Here the container IS the daemon: the server runs directly, so none of the platform
# daemon-controller code is used.
#
# Three stages, two images:
#   build        compilers + pnpm: installs and builds /app. Never shipped.
#   agents       downloads the agent CLIs and checks each against a pinned hash. Never shipped.
#   pytools      installs the Python document libraries (docker/hosted/tools/requirements.lock, every file
#                checked against its hash) into /opt/dispatch/python. Never shipped; the runtime copies the folder.
#   runtime      THE image (`dispatch-box:<version>`): no compiler, no setuid file, a non-root default
#                user, the harness policy files in their system locations, nothing written outside
#                $HOME and /tmp. This is what a business person's box runs.
#   runtime-dev  the same plus a build toolchain and the developer harness policy (agents may run with
#                approvals skipped). Build it with `--target runtime-dev`; give it its own tag. Not the
#                default: a business person must never get it.
#
# Design notes that are easy to get wrong:
#   • SHELL=/bin/bash — platform/darwin.ts's resolveLoginPath() (inherited by linux) runs
#     `$SHELL -ilc`, defaulting to /bin/zsh which doesn't exist here.
#   • The workspace-root postinstall (scripts/fix-node-pty-perms.mjs) restores the exec bit on
#     node-pty's spawn-helper. Without it every pty.spawn() fails. It runs in the build stage.
#   • NO ANTHROPIC_API_KEY / OPENAI_API_KEY may reach this image. Auth precedence puts an API key
#     ABOVE the person's subscription login. Asserted at startup by entrypoint.sh.
#   • managed-settings.json deliberately does NOT set forceLoginOrgUUID: the estate is mixed (Team
#     seats + individual Max), and Claude Code exits at startup when the credential belongs to a
#     different org.

# The base image, by DIGEST (the multi-arch index of node:22-trixie-slim, 2026-11-12). A tag can move;
# this cannot. To update: `docker buildx imagetools inspect node:22-trixie-slim`, put the new index
# digest here, rebuild, read the registry scan.
ARG NODE_IMAGE=node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64

# ── build: /app ─────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
#   build-essential/python3 : node-gyp fallback if a native prebuild is missing (node-pty, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/usr/local/pnpm PATH=/usr/local/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate
WORKDIR /app
COPY . .
# Dev-only dependencies are needed to BUILD (tsc, vite), so install the full tree.
RUN NODE_ENV=development pnpm install --frozen-lockfile \
    && NODE_ENV=development pnpm -r run build
# The harness policy files as installed: the Claude Code ones get the POLYWOOD spinner words, read from
# the web client's word-set file (packages/core/src/os/hosted-claude-policy.ts). Fails when the set is missing.
RUN node packages/core/dist/os/hosted-claude-policy-cli.js docker/hosted/policy /out/policy
# The daemon runs from dist: the core sources, tests and stand-in harness programs are not shipped (the
# proof mounts its stand-in from the repository). The web sources stay: the daemon reads the spinner word
# set from packages/web/src/lib/spinnerWords.ts (settings/word-sets.ts).
RUN rm -rf packages/core/src packages/core/tests packages/core/vitest.config.ts packages/core/tsconfig.test.json

# ── agents: the agent CLIs, each checked against a pinned hash ──────────────────────────────────────
FROM ${NODE_IMAGE} AS agents
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Claude Code: the release binary itself (a standalone executable), fetched from the release bucket and
# compared with the SHA-256 written HERE. No installer script runs. To move the version: take the
# `checksum` of `linux-arm64` and `linux-x64` from
# https://downloads.claude.ai/claude-code-releases/<version>/manifest.json and change all three values.
ARG CLAUDE_VERSION=2.1.322
ARG CLAUDE_SHA256_ARM64=f220ca50ea4f3222043ff83cc224a1262e0196e9897acc0871efa94235b0c1fd
ARG CLAUDE_SHA256_AMD64=bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH}" in \
      arm64) plat=linux-arm64; sum="${CLAUDE_SHA256_ARM64}" ;; \
      amd64) plat=linux-x64;   sum="${CLAUDE_SHA256_AMD64}" ;; \
      *) echo "no pinned Claude Code binary for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /out/claude; \
    curl -fsSL -o /out/claude/claude "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/${plat}/claude"; \
    echo "${sum}  /out/claude/claude" | sha256sum -c -; \
    chmod 755 /out/claude/claude; \
    echo "${CLAUDE_VERSION}" > /out/claude/VERSION
# Codex, OpenCode and mcp-remote: `npm ci` from the lockfile in docker/hosted/agent-clis, which pins every
# package (theirs and their dependencies) by integrity hash. A package that does not match fails the build.
COPY docker/hosted/agent-clis/package.json docker/hosted/agent-clis/package-lock.json /out/agent-clis/
RUN cd /out/agent-clis && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
    && test -x node_modules/.bin/codex && test -x node_modules/.bin/opencode && test -x node_modules/.bin/mcp-remote
# OpenCode ships one 200 MB binary per C library and its install step copies the one it picks: three
# copies in all. Keep the one this image runs (glibc) and make the copy a link to it.
RUN cd /out/agent-clis/node_modules && rm -rf opencode-linux-*-musl \
    && for d in opencode-linux-*; do \
         if cmp -s "$d/bin/opencode" opencode-ai/bin/opencode.exe; then ln -sf "../../$d/bin/opencode" opencode-ai/bin/opencode.exe; fi; \
       done \
    && ./.bin/opencode --version
# Every user may read the CLIs and enter their folders. Set HERE, not after the copy into the runtime: a
# `chmod -R` there wrote a second full copy of the CLIs into a new layer (about 400 MB more to pull).
RUN chmod -R a+rX /out/agent-clis /out/claude

# ── pytools: the Python document libraries, each file checked against its pinned hash ───────────────
# The same base as the runtime, so the same Python (3.13). pip and the compilers stay in this stage: the
# runtime gets only the installed folder. Some dependencies are source packages (pure Python), which pip
# builds here. pip writes the compiled .pyc files (the root file system is read-only at run time). To change the list: edit docker/hosted/tools/requirements.in and make the lock again (the
# command is in that file).
FROM ${NODE_IMAGE} AS pytools
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-setuptools python3-wheel build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY docker/hosted/tools/requirements.lock /tmp/requirements.lock
# --no-build-isolation: a source package builds with the Debian setuptools and wheel installed above (signed by
# apt), never with a build backend pip would download without a hash.
RUN python3 -m pip install --no-cache-dir --break-system-packages --no-warn-script-location --require-hashes --no-build-isolation \
      --target /opt/dispatch/python -r /tmp/requirements.lock \
    && cd /opt/dispatch/python \
    && rm -rf bin pandas/tests numpy/*/tests numpy/tests pyarrow/tests matplotlib/tests \
    && chmod -R a+rX,go-w .

# ── runtime: the image ──────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

# OS packages. `upgrade` first: the fixes Debian has published since the base image was built.
# What is here and why (everything else was removed; see docs/hosted.md, "What the image holds"):
#   git             the daemon's own git routes (status, diff, worktrees) and every harness
#   ca-certificates TLS to the platform and to the model providers
#   ripgrep         Claude Code's search tool
#   procps          platform.listProcessIds() shells out to `ps`
#   less            the pager of git and of the CLIs
# Not here: compilers and make (build stage only), curl, pip, pnpm, corepack.
# (util-linux, which has `setpriv`, is part of the base system.)
RUN apt-get update && apt-get -y upgrade \
    && apt-get install -y --no-install-recommends git ca-certificates ripgrep procps less \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
    && rm -rf /usr/local/lib/node_modules/corepack /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

# ── Document tools: what an agent needs to read a person's attachments (docker/hosted/tools/tools.txt) ──
# One layer per group, so the size of each is visible in `docker history`. No ImageMagick and no
# Ghostscript (their security history; Pillow and poppler cover the same files), no LibreOffice, no
# browser, no LaTeX, no Java. The setuid sweep below covers these packages too.
#   archives, PDF, OCR and small data CLIs
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip zip 7zip poppler-utils qpdf tesseract-ocr tesseract-ocr-eng jq sqlite3 file \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
#   pandoc (document conversion)
RUN apt-get update && apt-get install -y --no-install-recommends pandoc \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
#   fonts for charts, PDFs and OCR output
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-liberation fonts-noto-core \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
#   Python (no pip) and the libraries of the pytools stage. A .pth file puts /opt/dispatch/python on the
#   path of the system python3, so `python3 -c "import pandas"` works for every user. Root-owned, read-only.
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
    && ! python3 -m pip --version >/dev/null 2>&1
COPY --from=pytools --chown=root:root /opt/dispatch/python /opt/dispatch/python
RUN echo /opt/dispatch/python > /usr/lib/python3/dist-packages/dispatch-tools.pth \
    && python3 -I -c "import pptx, docx, openpyxl, xlsxwriter, pypdf, pdfplumber, reportlab, PIL, matplotlib, pandas, numpy, duckdb, pyarrow, tabulate, dateutil, chardet, extract_msg, icalendar, markdown, bs4, lxml"
# The list of these tools, with versions, for the agent (the daemon's environment note points to it).
COPY docker/hosted/tools/tools.txt docker/hosted/tools/write-tools-json.py /tmp/tools/
RUN install -d -m 755 /etc/dispatch \
    && python3 -I /tmp/tools/write-tools-json.py /tmp/tools/tools.txt /etc/dispatch/tools.json \
    && chmod 644 /etc/dispatch/tools.json && rm -rf /tmp/tools

# The runtime user. uid/gid 1000 must match the EFS access point's POSIX owner. The node base image
# already ships a `node` user at 1000:1000, so rename it rather than creating a second account.
RUN groupmod -n dispatch node \
    && usermod -l dispatch -d /home/dispatch -m -s /bin/bash node

ENV SHELL=/bin/bash \
    AGENT_HOME=/opt/agents \
    PATH=/opt/agents/.local/bin:/usr/local/bin:$PATH \
    DISABLE_AUTOUPDATER=1 \
    NODE_ENV=production

# /app: root-owned and read-only to the runtime user. A thread must not be able to change the daemon
# it runs under.
COPY --from=build --chown=root:root /app /app

# The agent CLIs, root-owned, outside $HOME ($HOME is the EFS mount in production and would shadow them).
# Claude Code keeps the layout its own installer makes (versions/<v> and a link in .local/bin).
ARG CLAUDE_VERSION=2.1.322
COPY --from=agents --chown=root:root /out/claude/claude /opt/agents/.local/share/claude/versions/${CLAUDE_VERSION}
COPY --from=agents --chown=root:root /out/agent-clis /opt/agent-clis
RUN mkdir -p /opt/agents/.local/bin \
    && ln -sf "/opt/agents/.local/share/claude/versions/${CLAUDE_VERSION}" /opt/agents/.local/bin/claude \
    && ln -sf /opt/agents/.local/bin/claude /usr/local/bin/claude \
    && for cli in codex opencode mcp-remote; do ln -sf "/opt/agent-clis/node_modules/.bin/${cli}" "/usr/local/bin/${cli}"; done \
    && printf '%s\n' 'export PATH="/opt/agents/.local/bin:$PATH"' > /etc/profile.d/agent-clis.sh \
    && chmod a+rX /opt/agents /opt/agents/.local /opt/agents/.local/bin /opt/agents/.local/share /opt/agents/.local/share/claude /opt/agents/.local/share/claude/versions /opt/agent-clis

# Verify the CLIs resolve on a LOGIN shell's PATH (startServer() replaces process.env.PATH with the
# login shell's), and that each runs.
RUN bash -lc 'command -v claude && command -v codex && command -v opencode && command -v mcp-remote && claude --version && codex --version && opencode --version'

# ── Harness policy: root-owned, in each harness's system location (docker/hosted/policy/README.md) ──
# A harness reads these above every user, project and command-line setting. So an agent that starts a
# second `claude` or `codex` from a shell cannot make it skip approvals: the files are not its to change.
COPY --from=build --chown=root:root /out/policy/ /opt/dispatch/policy/
# managed-settings.d: Claude Code's drop-in folder, a link to a root-owned folder on the run volume. The
# daemon (root, with privilege separation) writes the business MCP allow-list there
# (packages/core/src/os/hosted-mcp-policy.ts); nobody else can write it. A missing target is no policy.
RUN install -d -m 755 /etc/claude-code /etc/codex \
    && install -m 644 /opt/dispatch/policy/claude-managed-settings.json /etc/claude-code/managed-settings.json \
    && install -m 644 /opt/dispatch/policy/codex-requirements.toml /etc/codex/requirements.toml \
    && ln -s /run/dispatch/claude-policy /etc/claude-code/managed-settings.d \
    && chmod -R a-w /opt/dispatch/policy

COPY --chown=root:root docker/hosted/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

# No program in this image gains rights when it runs: every setuid and setgid bit is removed (su, mount,
# umount, passwd, chsh, chfn, newgrp, gpasswd, chage, expiry, unix_chkpwd in the base). Fargate cannot
# set `no-new-privileges` (dockerSecurityOptions is not valid there), so the image carries the rule itself.
# Privilege separation needs no setuid helper: the daemon (root) changes the user of each child itself.
RUN find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
    && test -z "$(find / -xdev -type f -perm /6000 2>/dev/null)"

# ── Privilege separation (docs/hosted-privilege-separation.md) ───────────────────
#   /var/lib/dispatch          root, 0700: the lock. The volume for the daemon's state is mounted at
#                              /var/lib/dispatch/state; no other user can walk through the parent.
#   /run/dispatch/agent        root, 0755: what the daemon writes for workloads to read.
#   /run/dispatch/private      root, 0700: the daemon's own scratch space (uploads in transit).
# /run/dispatch is declared a volume so that a platform volume mounted there (a read-only root file
# system) takes these folders' owner and mode.
RUN install -d -o root -g root -m 0700 /var/lib/dispatch /var/lib/dispatch/state \
    && install -d -o root -g root -m 0755 /run/dispatch /run/dispatch/agent /run/dispatch/claude-policy \
    && install -d -o root -g root -m 0700 /run/dispatch/private
VOLUME ["/run/dispatch"]

# A read-only root file system works: the daemon and the harnesses write only under $HOME (the EFS
# volume), /tmp, and with privilege separation the state volume and /run/dispatch. /tmp is declared a volume so that a platform volume mounted there takes this
# directory's mode (1777) and a non-root process can write to it.
RUN chmod 1777 /tmp /var/tmp
VOLUME ["/tmp"]

ENV HOME=/home/dispatch
WORKDIR /home/dispatch
EXPOSE 3456

# DISPATCH_WEB_DIST is set explicitly because the server's fallback resolves relative to its own dist/
# location, and we run with a different CWD than the repo root.
ENV DISPATCH_WEB_DIST=/app/packages/web/dist \
    PORT=3456

# TRANSITIONAL (kept on 2026-11-12, after a read of the platform's provisioner): the platform code that
# runs today writes ONE value into DISPATCH_BOX_TOKEN and OS_BOX_TOKEN. Its code for privilege
# separation mints two different values, but only when it registers a new task definition, so a box gets
# them at its next rebuild. This image must start in both situations. Without this switch the daemon
# refuses to start with one value in both roles (platform/box-secrets.ts); with two different values the
# switch does nothing. REMOVE THIS LINE when every box has been rebuilt by platform code that mints two.
# (The name holds the word TOKEN; the value is a switch, not a secret.)
ENV DISPATCH_ALLOW_SHARED_BOX_TOKEN=1

# The default user is the runtime user: the daemon, `docker exec` and any other command run as uid 1000.
# The entrypoint needs root for nothing in the standard mode. (It can still be STARTED as root, with
# `user: "0"`, for the model-gateway mode; it then drops to uid 1000 itself. See entrypoint.sh.)
USER dispatch
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# ── runtime-dev: a developer's box ──────────────────────────────────────────────────────────────────
# The toolchain a developer's agents use, and the developer harness policy (approvals may be skipped:
# CLI threads and unattended agents work as on a local install). Never for a business person.
FROM runtime AS runtime-dev
USER root
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/* \
    && install -m 644 /opt/dispatch/policy/claude-managed-settings.developer.json /etc/claude-code/managed-settings.json \
    && install -m 644 /opt/dispatch/policy/codex-requirements.developer.toml /etc/codex/requirements.toml \
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
ENV DISPATCH_IMAGE_VARIANT=developer
USER dispatch
