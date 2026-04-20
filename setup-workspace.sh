#!/usr/bin/env bash

set -euo pipefail

WORKSPACE="${WORKSPACE:-/workspace}"
BOOTSTRAP_FLAG="$WORKSPACE/.bootstrapped"
NVM_DIR="$WORKSPACE/.nvm"
HOMEBREW_PREFIX="$WORKSPACE/homebrew"
BASHRC_PATH="$WORKSPACE/.bashrc"
BASH_PROFILE_PATH="$WORKSPACE/.bash_profile"
PROJECTS_DIR="$WORKSPACE/projects"
NPM_GLOBAL_DIR="$WORKSPACE/.npm-global"
PYTHON_USERBASE="$WORKSPACE/.local"

if [[ -f "$BOOTSTRAP_FLAG" ]]; then
  echo "[bootstrap] workspace already initialized"
  exit 0
fi

mkdir -p "$WORKSPACE" "$PROJECTS_DIR" "$NPM_GLOBAL_DIR/bin" "$PYTHON_USERBASE/bin"

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

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  rm -rf "$NVM_DIR"
  mkdir -p "$NVM_DIR"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null NVM_DIR="$NVM_DIR" bash
fi

if [[ ! -x "$HOMEBREW_PREFIX/bin/brew" ]]; then
  rm -rf "$HOMEBREW_PREFIX"
  NONINTERACTIVE=1 CI=1 HOMEBREW_PREFIX="$HOMEBREW_PREFIX" /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

touch "$BOOTSTRAP_FLAG"
echo "[bootstrap] workspace initialized at $WORKSPACE"
