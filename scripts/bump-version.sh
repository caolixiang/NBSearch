#!/usr/bin/env sh

set -eu

ROOT_DIR="${NBSEARCH_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
PACKAGE_JSON="$ROOT_DIR/package.json"
TAURI_CONF="$ROOT_DIR/src-tauri/tauri.conf.json"
CARGO_TOML="$ROOT_DIR/src-tauri/Cargo.toml"

require_file() {
  if [ ! -f "$1" ]; then
    printf 'Missing file: %s\n' "$1" >&2
    exit 1
  fi
}

read_json_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

read_cargo_version() {
  sed -n 's/^version = "\([^"]*\)"$/\1/p' "$1" | head -n 1
}

normalize_version() {
  value=$(printf '%s' "$1" | tr -d '[:space:]')
  value=${value#v}
  printf '%s' "$value"
}

prompt_version() {
  printf '请输入版本号（例如 0.1.2 或 v0.1.2）: '
  IFS= read -r input_version
  printf '%s' "$input_version"
}

validate_version() {
  if [ -z "$1" ]; then
    printf 'Version cannot be empty.\n' >&2
    exit 1
  fi

  if ! printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.+-]+)?$'; then
    printf 'Invalid version: %s\n' "$1" >&2
    exit 1
  fi
}

replace_json_version() {
  perl -0pi -e 's/"version"\s*:\s*"[^"]+"/"version": "'"$2"'"/' "$1"
}

replace_cargo_version() {
  perl -0pi -e 's/^version = "[^"]+"/version = "'"$2"'"/m' "$1"
}

require_file "$PACKAGE_JSON"
require_file "$TAURI_CONF"
require_file "$CARGO_TOML"

RAW_VERSION=${1:-}
if [ -z "$RAW_VERSION" ]; then
  RAW_VERSION=$(prompt_version)
fi

VERSION=$(normalize_version "$RAW_VERSION")
validate_version "$VERSION"

OLD_PACKAGE_VERSION=$(read_json_version "$PACKAGE_JSON")
OLD_TAURI_VERSION=$(read_json_version "$TAURI_CONF")
OLD_CARGO_VERSION=$(read_cargo_version "$CARGO_TOML")

replace_json_version "$PACKAGE_JSON" "$VERSION"
replace_json_version "$TAURI_CONF" "$VERSION"
replace_cargo_version "$CARGO_TOML" "$VERSION"

printf 'Updated version to %s\n' "$VERSION"
printf '  %s: %s -> %s\n' "$PACKAGE_JSON" "$OLD_PACKAGE_VERSION" "$(read_json_version "$PACKAGE_JSON")"
printf '  %s: %s -> %s\n' "$TAURI_CONF" "$OLD_TAURI_VERSION" "$(read_json_version "$TAURI_CONF")"
printf '  %s: %s -> %s\n' "$CARGO_TOML" "$OLD_CARGO_VERSION" "$(read_cargo_version "$CARGO_TOML")"
printf 'Suggested next steps: git diff && git commit && git tag v%s\n' "$VERSION"
