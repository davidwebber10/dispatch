#!/bin/bash
# Hosted Dispatch box entrypoint. The container IS the daemon — no launchd/systemd.
#
# The image's default user is `dispatch` (uid 1000), and in the standard mode this script needs root
# for NOTHING: the harness policy files are part of the image, $HOME is the person's volume, and the
# daemon is started with `exec`. It works with a read-only root file system and with every capability
# dropped.
#
# It can still be STARTED as root (`user: "0"` in the task definition) for one thing:
#   • DISPATCH_ALLOW_MODEL_GATEWAY=1 (tests and a later phase): the Claude Code policy without
#     `forceLoginMethod` has to replace the image's file, which only root can do.
# In that case it does the root-only step and then runs the daemon as uid 1000 with setpriv (which
# needs the SETUID and SETGID capabilities, and a writable /etc/claude-code). Nothing else runs as root.
#
# PRIVILEGE SEPARATION HOOKS IN HERE: `start_daemon` is the one place that decides which user the daemon
# runs as. A design that runs the agents under a second user creates that user's folders and hands over
# the box secrets in the root branch below, before `start_daemon`.
set -euo pipefail

RUN_UID=1000
RUN_GID=1000
export HOME=/home/dispatch
POLICY_DIR=/opt/dispatch/policy
MANAGED=/etc/claude-code/managed-settings.json

# --- Credential guard ------------------------------------------------------
# Claude Code's auth precedence puts an API key ABOVE the user's subscription OAuth login. If one
# leaks in from the task definition, every user on every box silently stops using their own account
# and bills to one shared secret instead. That failure is invisible from the UI, so fail loudly.
for var in ANTHROPIC_API_KEY OPENAI_API_KEY; do
  if [ -n "${!var:-}" ]; then
    echo "FATAL: $var is set. Hosted boxes authenticate with each user's own" >&2
    echo "       subscription login; an API key here would override it silently." >&2
    echo "       Remove it from the task definition. Refusing to start." >&2
    exit 1
  fi
done

# --- Harness policy ----------------------------------------------------------
# The image carries the policy (docker/hosted/policy): /etc/claude-code/managed-settings.json and
# /etc/codex/requirements.toml, root-owned. This block only checks what is there, and handles the one
# mode that needs another file.
if [ "${DISPATCH_ALLOW_MODEL_GATEWAY:-}" = "1" ]; then
  # ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_CUSTOM_HEADERS and the model variables pass
  # through to the agents, and `forceLoginMethod` must be absent. Approvals stay as strict as ever.
  if [ "$(id -u)" != "0" ]; then
    echo "FATAL: DISPATCH_ALLOW_MODEL_GATEWAY=1 needs the container to start as root (user 0): the" >&2
    echo "       Claude Code policy file of the image has to be replaced. Refusing to start." >&2
    exit 1
  fi
  install -m 644 "$POLICY_DIR/claude-managed-settings.gateway.json" "$MANAGED"
  echo "dispatch box: MODEL GATEWAY mode (DISPATCH_ALLOW_MODEL_GATEWAY=1): base_url=${ANTHROPIC_BASE_URL:-<unset>}"
elif [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  echo "FATAL: ANTHROPIC_AUTH_TOKEN is set without DISPATCH_ALLOW_MODEL_GATEWAY=1. Refusing to start." >&2
  exit 1
fi
if [ ! -r "$MANAGED" ]; then
  echo "FATAL: $MANAGED is missing. The image must carry the harness policy. Refusing to start." >&2
  exit 1
fi
if grep -q '"disableBypassPermissionsMode"' "$MANAGED"; then
  echo "dispatch box: harness policy: strict (no harness can skip approvals)"
else
  echo "dispatch box: harness policy: DEVELOPER (a harness may skip approvals). Not for a business person."
fi

# --- Owner identity --------------------------------------------------------
echo "dispatch box: owner=${DISPATCH_OWNER_EMAIL:-<unset>} box=${DISPATCH_BOX_ID:-<unset>} profile=${DISPATCH_PROFILE:-<unset>} os_public=${OS_PUBLIC_URL:-<unset>} uid=$(id -u)"

if [ -z "${DISPATCH_BOX_TOKEN:-}" ]; then
  echo "WARN: DISPATCH_BOX_TOKEN is unset — the daemon will accept unauthenticated" >&2
  echo "      requests. Acceptable only for a local spike, never in the VPC." >&2
fi

# --- Data dir --------------------------------------------------------------
# ~/.dispatch holds the SQLite DB + runtime files. On Fargate $HOME is the EFS mount (its access point
# makes uid 1000 the owner), so the folder may already exist and be populated from a previous task.
if [ "$(id -u)" = "0" ]; then
  install -d -o "$RUN_UID" -g "$RUN_GID" -m 700 "$HOME/.dispatch"
  chown "$RUN_UID:$RUN_GID" "$HOME" 2>/dev/null || true
else
  if ! mkdir -p "$HOME/.dispatch" 2>/dev/null || ! [ -w "$HOME/.dispatch" ]; then
    echo "FATAL: $HOME is not writable by uid $(id -u). Mount the person's volume there, owned by uid $RUN_UID." >&2
    exit 1
  fi
  chmod 700 "$HOME/.dispatch" 2>/dev/null || true
fi

# --- The image's agent CLIs win ----------------------------------------------
# The in-app installer once put CLIs into the HOME volume ($HOME/.dispatch/tools/bin). A copy there
# is first on the threads' PATH and shadows every image upgrade, so a CLI this image ships is moved
# aside (renamed, never deleted) at each start.
TOOLS_BIN="$HOME/.dispatch/tools/bin"
for cli in claude codex opencode; do
  if [ -e "$TOOLS_BIN/$cli" ] && command -v "$cli" >/dev/null 2>&1; then
    mv -f "$TOOLS_BIN/$cli" "$TOOLS_BIN/$cli.shadowed-by-image" 2>/dev/null && \
      echo "dispatch box: moved a HOME copy of $cli aside; the image's $(command -v "$cli") is used"
  fi
done

echo "dispatch: claude=$(command -v claude || echo MISSING) codex=$(command -v codex || echo MISSING) opencode=$(command -v opencode || echo MISSING)"
# A stable host name in prompts (the container's own name changes with each task).
export HOSTNAME="${DISPATCH_BOX_ID:-dispatch-box}"

# The daemon, as uid 1000. The task's environment passes through as it is (the API-key guard above
# already ran); the daemon takes the two box secrets out of its own environment before it starts
# anything (platform/box-secrets.ts).
start_daemon() {
  if [ "$(id -u)" = "0" ]; then
    exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --init-groups -- \
      env HOME="$HOME" USER=dispatch LOGNAME=dispatch SHELL=/bin/bash HOSTNAME="$HOSTNAME" \
      node /app/packages/core/dist/server.js
  fi
  exec env HOME="$HOME" USER=dispatch LOGNAME=dispatch SHELL=/bin/bash HOSTNAME="$HOSTNAME" \
    node /app/packages/core/dist/server.js
}
start_daemon
