#!/bin/bash
# Hosted Dispatch box entrypoint. The container IS the daemon — no launchd/systemd.
# It starts as root for two jobs only (the managed settings file, the HOME folders), then runs the
# daemon as `dispatch` (uid 1000) with setpriv.
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
install -d -o "$RUN_UID" -g "$RUN_GID" -m 700 "$HOME/.dispatch"
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
# The task's environment passes through as it is (the API-key guard above already ran).
exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --init-groups -- \
  env HOME="$HOME" USER=dispatch LOGNAME=dispatch SHELL=/bin/bash HOSTNAME="$HOSTNAME" \
  node /app/packages/core/dist/server.js
