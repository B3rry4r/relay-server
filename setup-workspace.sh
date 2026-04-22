#!/usr/bin/env bash

set -euo pipefail

WORKSPACE="${WORKSPACE:-/workspace}"
BOOTSTRAP_FLAG="$WORKSPACE/.bootstrapped"
BOOTSTRAP_STATUS_PATH="$WORKSPACE/.bootstrap-status"
RELAY_ROOT="$WORKSPACE/.relay"
RELAY_TOOLS_DIR="$RELAY_ROOT/tools"
RELAY_CACHE_DIR="$RELAY_ROOT/cache"
RELAY_BIN_DIR="$RELAY_ROOT/bin"
RELAY_STATE_DIR="$RELAY_ROOT/state"
RELAY_ENV_PATH="$RELAY_STATE_DIR/tool-env.sh"
NVM_DIR="$RELAY_TOOLS_DIR/nvm"
MISE_DIR="$RELAY_TOOLS_DIR/mise"
MISE_BIN_DIR="$MISE_DIR/bin"
MISE_DATA_DIR="$RELAY_TOOLS_DIR/mise-data"
MISE_CONFIG_DIR="$RELAY_STATE_DIR/mise"
NIX_PROFILES_DIR="$RELAY_TOOLS_DIR/nix-profiles"
BASHRC_PATH="$WORKSPACE/.bashrc"
BASH_PROFILE_PATH="$WORKSPACE/.bash_profile"
PROJECTS_DIR="$WORKSPACE/projects"
NPM_GLOBAL_DIR="$RELAY_TOOLS_DIR/npm-global"
PYTHON_USERBASE="$RELAY_TOOLS_DIR/python-userbase"
PUB_CACHE_DIR="$RELAY_CACHE_DIR/dart-pub"
PIP_CACHE_DIR="$RELAY_CACHE_DIR/pip"
CARGO_HOME_DIR="$RELAY_CACHE_DIR/cargo"
RUSTUP_HOME_DIR="$RELAY_TOOLS_DIR/rustup"
GO_HOME_DIR="$RELAY_CACHE_DIR/go"
GRADLE_HOME_DIR="$RELAY_CACHE_DIR/gradle"
FLUTTER_HOME_DIR="$RELAY_TOOLS_DIR/flutter"
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
mkdir -p "$RELAY_ROOT" "$RELAY_TOOLS_DIR" "$RELAY_CACHE_DIR" "$RELAY_BIN_DIR" "$RELAY_STATE_DIR" \
  "$PUB_CACHE_DIR" "$PIP_CACHE_DIR" "$CARGO_HOME_DIR/bin" "$GO_HOME_DIR/bin" "$GRADLE_HOME_DIR" \
  "$MISE_DIR" "$MISE_DATA_DIR" "$MISE_CONFIG_DIR" "$NIX_PROFILES_DIR" "$WORKSPACE/.gemini"
printf '' > "$BOOTSTRAP_STATUS_PATH"
record_status workspace "$WORKSPACE"
record_status relay_root "ready"
record_status relay_tools "ready"
record_status relay_cache "ready"
record_status relay_bin "ready"
record_status relay_state "ready"
record_status projects_dir "ready"
record_status npm_global "ready"
record_status python_userbase "ready"
record_status nix_profiles "ready"

if ! has_command mise; then
  curl https://mise.run | MISE_INSTALL_PATH="$MISE_BIN_DIR/mise" sh
fi
record_status mise "installed"

if has_command nix; then
  record_status nix "available"
else
  record_status nix "missing"
  BOOTSTRAP_COMPLETE=0
fi

cat > "$RELAY_BIN_DIR/relay-browser" <<EOF
#!/usr/bin/env bash
set -euo pipefail
URL="\${1:-}"
STATE_PATH="\${RELAY_BROWSER_STATE_PATH:-$RELAY_STATE_DIR/browser-url.txt}"
mkdir -p "\$(dirname "\$STATE_PATH")"
printf '%s\n' "\$URL" > "\$STATE_PATH"
printf '[relay] Browser auth URL: %s\n' "\$URL" >&2
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "\$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "\$URL" >/dev/null 2>&1 || true
fi
EOF
chmod +x "$RELAY_BIN_DIR/relay-browser"
record_status relay_browser "ready"

if [[ ! -f "$WORKSPACE/.gemini/settings.json" ]]; then
  cat > "$WORKSPACE/.gemini/settings.json" <<EOF
{
  "security": {
    "auth": {
      "selectedType": "oauth-personal"
    }
  }
}
EOF
else
  if ! grep -q '"selectedType"' "$WORKSPACE/.gemini/settings.json"; then
    cat > "$WORKSPACE/.gemini/settings.json" <<EOF
{
  "security": {
    "auth": {
      "selectedType": "oauth-personal"
    }
  }
}
EOF
  fi
fi
record_status gemini_auth "ready"

cat > "$RELAY_ENV_PATH" <<EOF
export RELAY_HOME="$RELAY_ROOT"
export RELAY_TOOLS="$RELAY_TOOLS_DIR"
export RELAY_CACHE="$RELAY_CACHE_DIR"
export RELAY_BIN="$RELAY_BIN_DIR"
export NVM_DIR="$NVM_DIR"
export MISE_DATA_DIR="$MISE_DATA_DIR"
export MISE_CONFIG_DIR="$MISE_CONFIG_DIR"
export npm_config_prefix="$NPM_GLOBAL_DIR"
export PYTHONUSERBASE="$PYTHON_USERBASE"
export PUB_CACHE="$PUB_CACHE_DIR"
export PIP_CACHE_DIR="$PIP_CACHE_DIR"
export CARGO_HOME="$CARGO_HOME_DIR"
export RUSTUP_HOME="$RUSTUP_HOME_DIR"
export GOPATH="$GO_HOME_DIR"
export GOMODCACHE="$GO_HOME_DIR/pkg/mod"
export GRADLE_USER_HOME="$GRADLE_HOME_DIR"
export FLUTTER_HOME="$FLUTTER_HOME_DIR"
export ANDROID_SDK_ROOT="$RELAY_TOOLS_DIR/android-sdk"
export CHROME_EXECUTABLE_PATH="/usr/bin/chromium"
export NIX_CONFIG="experimental-features = nix-command flakes"
export BROWSER="$RELAY_BIN_DIR/relay-browser"
export RELAY_BROWSER_STATE_PATH="$RELAY_STATE_DIR/browser-url.txt"
export PATH="$MISE_BIN_DIR:$RELAY_BIN_DIR:$GO_HOME_DIR/bin:$CARGO_HOME_DIR/bin:$NPM_GLOBAL_DIR/bin:$PYTHON_USERBASE/bin:$FLUTTER_HOME_DIR/bin:\$PATH"
[ -s "\$NVM_DIR/nvm.sh" ] && source "\$NVM_DIR/nvm.sh"
EOF

cat > "$BASHRC_PATH" <<EOF
export HOME="$WORKSPACE"
[ -f "$RELAY_ENV_PATH" ] && source "$RELAY_ENV_PATH"
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

if [[ "$BOOTSTRAP_COMPLETE" -eq 1 ]]; then
  touch "$BOOTSTRAP_FLAG"
  record_status bootstrap "complete"
  echo "[bootstrap] workspace initialized at $WORKSPACE"
else
  rm -f "$BOOTSTRAP_FLAG"
  record_status bootstrap "partial"
  echo "[bootstrap] workspace partially initialized at $WORKSPACE"
fi
