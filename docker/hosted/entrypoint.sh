#!/bin/bash
# Hosted Dispatch box entrypoint. The container IS the daemon — no launchd/systemd.
#
# The image's default user is `dispatch` (uid 1000), and in the standard mode this script needs root
# for NOTHING: the harness policy files are part of the image, $HOME is the person's volume, and the
# daemon is started with `exec`. It works with a read-only root file system and with every capability
# dropped.
#
# It can still be STARTED as root (`user: "0"` in the task definition) for one thing:
#   • DISPATCH_ALLOW_MODEL_GATEWAY=1 (tests and a later phase): the gateway policy file replaces the
#     image's file, and the forced-login drop-in is not written; only root can do either.
# In that case it does the root-only step and then runs the daemon as uid 1000 with setpriv (which
# needs the SETUID and SETGID capabilities, and a writable /etc/claude-code). Nothing else runs as root.
#
# PRIVILEGE SEPARATION (docs/hosted-privilege-separation.md): started as root WITH a volume for the
# daemon's state, the daemon stays root with a reduced capability set and runs every other process as
# uid 1000; the box secrets are handed over through a pipe. `start_daemon` at the end decides.
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
# Claude Code's drop-in folder (/etc/claude-code/managed-settings.d) leads to this folder. A file there is
# managed policy, so only root may ever write it: the daemon writes the business MCP allow-list there
# when it runs as root (privilege separation). Emptied at every start. A folder (or its parent) that
# another user could change stops the start: an agent could write its own policy there.
#
# The forced Claude login (`forceLoginMethod: "claudeai"`) lives in this folder too, as LOGIN_DROPIN: the
# image bakes it in, and a root start writes it again after emptying the folder. The daemon (root) lifts
# it only while the platform grants a company Claude model and turns the person's own login off
# (packages/core/src/os/login-policy.ts). A start that is not root cannot write it, so it must find it.
POLICY_DROPIN=/run/dispatch/claude-policy
LOGIN_DROPIN="$POLICY_DROPIN/10-dispatch-login.json"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$POLICY_DROPIN"
  chown 0:0 /run/dispatch "$POLICY_DROPIN"
  chmod 755 /run/dispatch "$POLICY_DROPIN"
  find "$POLICY_DROPIN" -mindepth 1 -delete
  if [ "${DISPATCH_ALLOW_MODEL_GATEWAY:-}" != "1" ]; then
    install -o 0 -g 0 -m 644 "$POLICY_DIR/claude-login-dropin.json" "$LOGIN_DROPIN"
  fi
elif ! grep -q '"forceLoginMethod"' "$LOGIN_DROPIN" 2>/dev/null; then
  echo "FATAL: $LOGIN_DROPIN is missing: Claude Code would not force the person's own login. Start the" >&2
  echo "       container as root (privilege separation), or keep the image's /run/dispatch. Refusing to start." >&2
  exit 1
fi
for d in /run/dispatch "$POLICY_DROPIN"; do
  [ -e "$d" ] || continue
  if [ "$(stat -c '%u' "$d")" != "0" ] || [ $(( 0$(stat -c '%a' "$d") & 022 )) -ne 0 ]; then
    echo "FATAL: $d must belong to root and be writable by root only (it holds harness policy). Refusing to start." >&2
    exit 1
  fi
done
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
  install -d -o "$RUN_UID" -g "$RUN_GID" -m 700 "$HOME/.dispatch" 2>/dev/null || true
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

# --- Privilege separation (docs/hosted-privilege-separation.md) -----------------
# When the container starts as root AND the task has a volume for the daemon's state, the daemon stays
# root (six capabilities, no_new_privs) and starts every other process as `dispatch` (uid 1000). Its
# state lives in STATE_DIR, below a folder only root can enter; the two box secrets reach it through a
# pipe and are in no environment a workload can read.
#
# An older task definition has no state volume: the state would be on the container's own disk and lost
# with the task. So without the volume (and without an explicit DISPATCH_PRIVSEP=1) the box starts the
# old way, as one user, and does not report `privsep-v1`.
STATE_GATE=/var/lib/dispatch
STATE_DIR="$STATE_GATE/state"
RUN_ROOT=/run/dispatch
AGENT_RUN_DIR="$RUN_ROOT/agent"
PRIVSEP="${DISPATCH_PRIVSEP:-auto}"
if [ "$PRIVSEP" = "auto" ]; then
  if [ "$(id -u)" = "0" ] && mountpoint -q "$STATE_DIR" 2>/dev/null; then PRIVSEP=1; else PRIVSEP=0; fi
fi
if [ "$PRIVSEP" = "1" ] && [ "$(id -u)" != "0" ]; then
  echo "FATAL: DISPATCH_PRIVSEP=1 needs the container to start as root (user 0): only root can start a" >&2
  echo "       process as another user. Refusing to start." >&2
  exit 1
fi

start_separated() {
  if ! mountpoint -q "$STATE_DIR" 2>/dev/null; then
    echo "WARN: $STATE_DIR is not a volume: the daemon's state will not outlive this container." >&2
  fi
  # The lock on the state: its parent, on the container's own disk. The daemon checks it again.
  if [ "$(stat -c '%u %a' "$STATE_GATE" 2>/dev/null)" != "0 700" ]; then
    echo "FATAL: $STATE_GATE must be owned by root with mode 0700 (the image makes it so). Refusing to start." >&2
    exit 1
  fi
  # What the daemon writes for workloads to read, and its own scratch space. A platform volume mounted
  # at RUN_ROOT (a read-only root file system) may arrive empty: make the folders again.
  mkdir -p "$AGENT_RUN_DIR" "$RUN_ROOT/private"
  chown 0:0 "$RUN_ROOT" "$AGENT_RUN_DIR" "$RUN_ROOT/private"
  chmod 755 "$RUN_ROOT" "$AGENT_RUN_DIR"
  chmod 700 "$RUN_ROOT/private"

  # The two secrets go through a pipe (descriptor 3) and leave the environment. PID 1 keeps the
  # container's original environment; it runs as root, so a workload cannot read it. A here-string
  # leaves no helper process behind; it is used when both values are plain token characters (they are:
  # the platform mints them), and anything else is encoded by node.
  if [[ "${DISPATCH_BOX_TOKEN:-}${OS_BOX_TOKEN:-}" =~ ^[A-Za-z0-9._~+/=-]*$ ]]; then
    exec 3<<<"{\"DISPATCH_BOX_TOKEN\":\"${DISPATCH_BOX_TOKEN:-}\",\"OS_BOX_TOKEN\":\"${OS_BOX_TOKEN:-}\"}"
  else
    exec 3< <(node -e 'process.stdout.write(JSON.stringify({ DISPATCH_BOX_TOKEN: process.env.DISPATCH_BOX_TOKEN || "", OS_BOX_TOKEN: process.env.OS_BOX_TOKEN || "" }))')
  fi
  unset DISPATCH_BOX_TOKEN OS_BOX_TOKEN

  echo "dispatch box: privilege separation is ON (daemon: root with a reduced capability set; workloads: uid $RUN_UID)"
  # --no-new-privs and the bounding set are inherited by every workload. A workload itself holds no
  # capability: the kernel clears them all when the uid changes from root.
  exec setpriv --no-new-privs --clear-groups --inh-caps=-all \
      --bounding-set=-all,+chown,+dac_override,+fowner,+setgid,+setuid,+kill -- \
    env -u DISPATCH_BOX_TOKEN -u OS_BOX_TOKEN \
      DISPATCH_PRIVSEP=1 DISPATCH_AGENT_UID="$RUN_UID" DISPATCH_AGENT_GID="$RUN_GID" \
      DISPATCH_STATE_DIR="$STATE_DIR" DISPATCH_AGENT_RUN_DIR="$AGENT_RUN_DIR" DISPATCH_SECRETS_FD=3 \
      HOME="$HOME" USER=dispatch LOGNAME=dispatch SHELL=/bin/bash HOSTNAME="$HOSTNAME" \
    node /app/packages/core/dist/server.js
}

# The daemon. With privilege separation: see above. Otherwise as uid 1000: the task's environment
# passes through as it is (the API-key guard above already ran), and the daemon takes the two box
# secrets out of its own environment before it starts anything (platform/box-secrets.ts).
start_daemon() {
  if [ "$PRIVSEP" = "1" ]; then start_separated; fi
  echo "dispatch box: privilege separation is OFF (not started as root with a state volume at $STATE_DIR, or DISPATCH_PRIVSEP=0). One user runs everything."
  if [ "$(id -u)" = "0" ]; then
    exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --init-groups -- \
      env -u DISPATCH_PRIVSEP HOME="$HOME" USER=dispatch LOGNAME=dispatch SHELL=/bin/bash HOSTNAME="$HOSTNAME" \
      node /app/packages/core/dist/server.js
  fi
  exec env -u DISPATCH_PRIVSEP HOME="$HOME" USER=dispatch LOGNAME=dispatch SHELL=/bin/bash HOSTNAME="$HOSTNAME" \
    node /app/packages/core/dist/server.js
}
start_daemon
