#!/usr/bin/env bash
set -euo pipefail

# Ensure bash uses the Windows npm config file when running under Git Bash.
NPM_CONFIG_USERCONFIG="${NPM_CONFIG_USERCONFIG:-/c/Users/therceman/.npmrc}"
export NPM_CONFIG_USERCONFIG
export npm_config_userconfig="$NPM_CONFIG_USERCONFIG"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . .env
  set +a
fi

publish_userconfig="$NPM_CONFIG_USERCONFIG"
temp_userconfig=""

if [[ -n "${NPM_TOKEN:-}" ]]; then
  temp_userconfig="$(mktemp)"
  publish_userconfig="$temp_userconfig"
  {
    echo "registry=https://registry.npmjs.org/"
    echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}"
  } > "$publish_userconfig"
fi

npm pack --dry-run --userconfig "$publish_userconfig"

if [[ -n "${NPM_CONFIG_OTP:-}" ]]; then
  npm publish --userconfig "$publish_userconfig" --otp "$NPM_CONFIG_OTP"
else
  npm publish --userconfig "$publish_userconfig"
fi

if [[ -n "$temp_userconfig" ]]; then
  rm -f "$temp_userconfig"
fi
