#!/usr/bin/env bash
# entrypoint.sh — runs as the non-root 'dev' user (USER dev in the Dockerfile).
# The /workspace volume mounts root-owned on first attach, so dev can't write to
# it until we fix ownership. dev has passwordless sudo for exactly this.
set -euo pipefail

WORKSPACE="${WORKSPACE:-/workspace}"

if [ -d "$WORKSPACE" ] && [ "$(stat -c '%U' "$WORKSPACE")" != "dev" ]; then
  sudo chown -R dev:dev "$WORKSPACE"
fi

exec "$@"
