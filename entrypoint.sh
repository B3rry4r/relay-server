#!/usr/bin/env bash
# entrypoint.sh — boot as root only long enough to fix the volume's ownership,
# then drop to the non-root 'dev' user for the actual process.
#
# Railway attaches the volume root-owned on first mount, so a container that
# starts as non-root can't write to it. We chown it here (cheap after the first
# boot) and then hand off with gosu.
set -euo pipefail

WORKSPACE="${WORKSPACE:-/workspace}"
DEV_USER="dev"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$WORKSPACE/.relay"
  # Only chown if it isn't already dev-owned, so reboots stay fast.
  if [ "$(stat -c '%U' "$WORKSPACE")" != "$DEV_USER" ]; then
    chown -R "$DEV_USER:$DEV_USER" "$WORKSPACE"
  fi
  exec gosu "$DEV_USER" "$@"
fi

exec "$@"
