#!/bin/bash
# Hosted Dispatch box entrypoint. The container IS the daemon — no launchd/systemd.
# It starts as root for the managed settings file and the folders. With privilege separation (the
# default when the task has a state volume) the daemon then runs as root with a reduced capability
# set and starts every other process as `dispatch` (uid 1000); see the end of this file. Without it,
# the daemon itself runs as `dispatch`, as before.
set -euo pipefail

RUN_UID=1000
RUN_GID=1000
export HOME=/home/dispatch

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

# --- Model gateway (opt-in, tests and a later phase) -------------------------
# DISPATCH_ALLOW_MODEL_GATEWAY=1 lets ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN /
# ANTHROPIC_CUSTOM_HEADERS and the model variables (ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL, …)
# pass through to the agents, and does NOT write forceLoginMethod. Without it, a gateway token is
# refused like an API key: the default stays the person's own subscription login.
MANAGED=/etc/claude-code/managed-settings.json
if [ "${DISPATCH_ALLOW_MODEL_GATEWAY:-}" = "1" ]; then
  echo "dispatch box: MODEL GATEWAY mode (DISPATCH_ALLOW_MODEL_GATEWAY=1): base_url=${ANTHROPIC_BASE_URL:-<unset>}"
  rm -f "$MANAGED"
else
  if [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    echo "FATAL: ANTHROPIC_AUTH_TOKEN is set without DISPATCH_ALLOW_MODEL_GATEWAY=1. Refusing to start." >&2
    exit 1
  fi
  # forceLoginMethod=claudeai: the subscription path only (no Console login, no API-key helper), and
  # `claude auth login --claudeai` goes straight to the link with no chooser.
  printf '%s\n' '{"forceLoginMethod":"claudeai"}' > "$MANAGED"
  chmod 644 "$MANAGED"
fi

# --- Owner identity --------------------------------------------------------
echo "dispatch box: owner=${DISPATCH_OWNER_EMAIL:-<unset>} box=${DISPATCH_BOX_ID:-<unset>} profile=${DISPATCH_PROFILE:-<unset>} os_public=${OS_PUBLIC_URL:-<unset>}"

if [ -z "${DISPATCH_BOX_TOKEN:-}" ]; then
  echo "WARN: DISPATCH_BOX_TOKEN is unset — the daemon will accept unauthenticated" >&2
  echo "      requests. Acceptable only for a local spike, never in the VPC." >&2
fi

# --- Data dir --------------------------------------------------------------
# ~/.dispatch holds the SQLite DB + runtime files. On Fargate this is the EFS mount, so it may
# already exist and be populated from a previous task. Owned by the runtime user.
install -d -o "$RUN_UID" -g "$RUN_GID" -m 700 "$HOME/.dispatch" 2>/dev/null || true
chown "$RUN_UID:$RUN_GID" "$HOME" 2>/dev/null || true

# --- The image's agent CLIs win ----------------------------------------------
# The in-app installer once put CLIs into the HOME volume ($HOME/.dispatch/tools/bin). A copy there
# is first on the threads' PATH and shadows every image upgrade, so a CLI this image ships is moved
# aside (renamed, never deleted) at each start.
TOOLS_BIN="$HOME/.dispatch/tools/bin"
for cli in claude codex opencode; do
  if [ -e "$TOOLS_BIN/$cli" ] && command -v "$cli" >/dev/null 2>&1; then
    mv -f "$TOOLS_BIN/$cli" "$TOOLS_BIN/$cli.shadowed-by-image" && \
      echo "dispatch box: moved a HOME copy of $cli aside; the image's $(command -v "$cli") is used"
  fi
done

echo "dispatch: claude=$(command -v claude || echo MISSING) codex=$(command -v codex || echo MISSING) opencode=$(command -v opencode || echo MISSING)"
# A stable host name in prompts (the container's own name changes with each task).
export HOSTNAME="${DISPATCH_BOX_ID:-dispatch-box}"

# --- Privilege separation (docs/hosted-privilege-separation.md) -----------------
# The daemon runs as root with six capabilities and no_new_privs; every process it starts runs as
# `dispatch` (uid 1000). Its state lives in STATE_DIR, below a folder only root can enter; the two
# tokens reach it through a pipe and are in no environment a workload can read.
#
# This mode needs a volume for the state. An older task definition has none: the state would be on
# the container's own disk and lost with the task. So without a volume (and without an explicit
# DISPATCH_PRIVSEP=1) the box starts the old way, as one user, and does not report `privsep-v1`.
STATE_GATE=/var/lib/dispatch
STATE_DIR="$STATE_GATE/state"
AGENT_RUN_DIR=/run/dispatch/agent
MODE="${DISPATCH_PRIVSEP:-auto}"
if [ "$MODE" = "auto" ]; then
  if mountpoint -q "$STATE_DIR" 2>/dev/null; then MODE=1; else MODE=0; fi
fi

if [ "$MODE" != "1" ]; then
  echo "dispatch box: privilege separation is OFF (no state volume at $STATE_DIR, or DISPATCH_PRIVSEP=0). One user runs everything."
  # The task's environment passes through as it is (the API-key guard above already ran).
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --init-groups -- \
    env -u DISPATCH_PRIVSEP HOME="$HOME" USER=dispatch LOGNAME=dispatch SHELL=/bin/bash HOSTNAME="$HOSTNAME" \
    node /app/packages/core/dist/server.js
fi

if ! mountpoint -q "$STATE_DIR" 2>/dev/null; then
  echo "WARN: $STATE_DIR is not a volume: the daemon's state will not outlive this container." >&2
fi
# The lock on the state: its parent, on the container's own disk. The daemon checks it again.
if [ "$(stat -c '%u %a' "$STATE_GATE")" != "0 700" ]; then
  chown 0:0 "$STATE_GATE" && chmod 700 "$STATE_GATE"
fi
mkdir -p "$AGENT_RUN_DIR"
chown 0:0 /run/dispatch "$AGENT_RUN_DIR" && chmod 755 /run/dispatch "$AGENT_RUN_DIR"

# The two tokens go through a pipe (descriptor 3) and leave the environment. PID 1 keeps the
# container's original environment; it runs as root, so a workload cannot read it.
# A here-string leaves no helper process behind. It is used when both values are plain token
# characters (they are: the platform mints them); anything else is encoded by node instead.
if [[ "${DISPATCH_BOX_TOKEN:-}${OS_BOX_TOKEN:-}" =~ ^[A-Za-z0-9._~+/=-]*$ ]]; then
  exec 3<<<"{\"DISPATCH_BOX_TOKEN\":\"${DISPATCH_BOX_TOKEN:-}\",\"OS_BOX_TOKEN\":\"${OS_BOX_TOKEN:-}\"}"
else
  exec 3< <(node -e 'process.stdout.write(JSON.stringify({ DISPATCH_BOX_TOKEN: process.env.DISPATCH_BOX_TOKEN || "", OS_BOX_TOKEN: process.env.OS_BOX_TOKEN || "" }))')
fi
unset DISPATCH_BOX_TOKEN OS_BOX_TOKEN

echo "dispatch box: privilege separation is ON (daemon: root with a reduced capability set; workloads: uid $RUN_UID)"
# --bounding-set: what the daemon keeps. --no-new-privs and the bounding set are inherited by every
# workload; a workload itself holds no capability (the kernel clears them when the uid changes).
exec setpriv --no-new-privs --clear-groups --inh-caps=-all \
    --bounding-set=-all,+chown,+dac_override,+fowner,+setgid,+setuid,+kill -- \
  env -u DISPATCH_BOX_TOKEN -u OS_BOX_TOKEN \
    DISPATCH_PRIVSEP=1 DISPATCH_AGENT_UID="$RUN_UID" DISPATCH_AGENT_GID="$RUN_GID" \
    DISPATCH_STATE_DIR="$STATE_DIR" DISPATCH_AGENT_RUN_DIR="$AGENT_RUN_DIR" DISPATCH_SECRETS_FD=3 \
    HOME="$HOME" USER=dispatch LOGNAME=dispatch SHELL=/bin/bash HOSTNAME="$HOSTNAME" \
  node /app/packages/core/dist/server.js
