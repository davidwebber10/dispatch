#!/usr/bin/env bash
# Stops and removes the launchd daemon. Leaves ~/.dispatch data intact.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$DIR/bin/dispatch" uninstall
