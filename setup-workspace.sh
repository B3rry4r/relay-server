#!/usr/bin/env bash

set -euo pipefail

WORKSPACE="${WORKSPACE:-/workspace}"
BOOTSTRAP_FLAG="$WORKSPACE/.bootstrapped"
BOOTSTRAP_STATUS_PATH="$WORKSPACE/.bootstrap-status"
NVM_DIR="$WORKSPACE/.nvm"
HOMEBREW_PREFIX="$WORKSPACE/homebrew"
BASHRC_PATH="$WORKSPACE/.bashrc"
BASH_PROFILE_PATH="$WORKSPACE/.bash_profile"
PROJECTS_DIR="$WORKSPACE/projects"
NPM_GLOBAL_DIR="$WORKSPACE/.npm-global"
PYTHON_USERBASE="$WORKSPACE/.local"
BOOTSTRAP_COMPLETE=1

has_command() {
  command -v "$1" >/dev/null 2>&1
}

download_to_stdout() {
  local url="$1"

  if has_command curl; then
    curl -fsSL "$url"
    return
  fi

  if has_command node; then
    node -e '
      const url = process.argv[1];
      fetch(url)
        .then((response) => {
          if (!response.ok) {
            throw new Error("Unexpected status " + response.status);
          }
          return response.text();
        })
        .then((body) => process.stdout.write(body))
        .catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
    ' "$url"
    return
  fi

  echo "[bootstrap] neither curl nor node is available to download $url" >&2
  return 1
}

record_status() {
  local key="$1"
  local value="$2"
  printf '%s=%s\n' "$key" "$value" >> "$BOOTSTRAP_STATUS_PATH"
}

mkdir -p "$WORKSPACE" "$PROJECTS_DIR" "$NPM_GLOBAL_DIR/bin" "$PYTHON_USERBASE/bin"
printf '' > "$BOOTSTRAP_STATUS_PATH"
record_status workspace "$WORKSPACE"
record_status projects_dir "ready"
record_status npm_global "ready"
record_status python_userbase "ready"

cat > "$BASHRC_PATH" <<EOF
export HOME="$WORKSPACE"
export NVM_DIR="$NVM_DIR"
export npm_config_prefix="$NPM_GLOBAL_DIR"
export PYTHONUSERBASE="$PYTHON_USERBASE"
export PATH="$NPM_GLOBAL_DIR/bin:$PYTHON_USERBASE/bin:$HOMEBREW_PREFIX/bin:\$PATH"
[ -s "\$NVM_DIR/nvm.sh" ] && source "\$NVM_DIR/nvm.sh"
EOF

cat > "$BASH_PROFILE_PATH" <<EOF
if [ -f "$BASHRC_PATH" ]; then
  source "$BASHRC_PATH"
fi
EOF
record_status shell_config "ready"

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  rm -rf "$NVM_DIR"
  mkdir -p "$NVM_DIR"

  if has_command git; then
    if download_to_stdout https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null NVM_DIR="$NVM_DIR" bash; then
      record_status nvm "installed"
    else
      record_status nvm "failed"
      BOOTSTRAP_COMPLETE=0
    fi
  else
    echo "[bootstrap] skipping nvm install because git is unavailable" >&2
    record_status nvm "skipped"
    BOOTSTRAP_COMPLETE=0
  fi
else
  record_status nvm "ready"
fi

if [[ ! -x "$HOMEBREW_PREFIX/bin/brew" ]]; then
  rm -rf "$HOMEBREW_PREFIX"

  if has_command curl && has_command git; then
    if NONINTERACTIVE=1 CI=1 HOMEBREW_PREFIX="$HOMEBREW_PREFIX" /bin/bash -c \
      "$(download_to_stdout https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
      record_status homebrew "installed"
    else
      record_status homebrew "failed"
      BOOTSTRAP_COMPLETE=0
    fi
  else
    echo "[bootstrap] skipping Homebrew install because curl and git are required at runtime" >&2
    record_status homebrew "skipped"
    BOOTSTRAP_COMPLETE=0
  fi
else
  record_status homebrew "ready"
fi

if [[ "$BOOTSTRAP_COMPLETE" -eq 1 ]]; then
  touch "$BOOTSTRAP_FLAG"
  record_status bootstrap "complete"
  echo "[bootstrap] workspace initialized at $WORKSPACE"
else
  rm -f "$BOOTSTRAP_FLAG"
  record_status bootstrap "partial"
  echo "[bootstrap] workspace partially initialized at $WORKSPACE"
fi
