#!/bin/bash
# Hosted Dispatch box entrypoint. The container IS the daemon — no launchd/systemd.
set -euo pipefail

# --- Credential guard ------------------------------------------------------
# Claude Code's auth precedence puts ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN ABOVE
# the user's subscription OAuth login. If either leaks in from the surrounding task
# definition, every user on every box silently stops using their own account and
# bills to one shared secret instead. That failure is invisible from the UI, so fail
# loudly at boot rather than discover it on an invoice.
for var in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY; do
  if [ -n "${!var:-}" ]; then
    echo "FATAL: $var is set. Hosted boxes authenticate with each user's own" >&2
    echo "       subscription login; an API key here would override it silently." >&2
    echo "       Remove it from the task definition. Refusing to start." >&2
    exit 1
  fi
done

# --- Owner identity --------------------------------------------------------
# Informational for now; the box-token middleware (Dispatch change #1) is what
# actually enforces access. Logged so a misprovisioned box is obvious in the logs.
echo "dispatch box: owner=${DISPATCH_OWNER_EMAIL:-<unset>} plan=${DISPATCH_OWNER_PLAN:-<unset>}"

if [ -z "${DISPATCH_BOX_TOKEN:-}" ]; then
  echo "WARN: DISPATCH_BOX_TOKEN is unset — the daemon will accept unauthenticated" >&2
  echo "      requests. Acceptable only for a local spike, never in the VPC." >&2
fi

# --- Data dir --------------------------------------------------------------
# ~/.dispatch holds the SQLite DB + runtime files. On Fargate this is the EFS mount,
# so it may already exist and be populated from a previous task.
mkdir -p "$HOME/.dispatch"

echo "dispatch: claude=$(command -v claude || echo MISSING) codex=$(command -v codex || echo MISSING)"
exec node /app/packages/core/dist/server.js
