#!/usr/bin/env bash
# One-shot installer: builds Dispatch and installs the launchd daemon.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$DIR/bin/dispatch" install
