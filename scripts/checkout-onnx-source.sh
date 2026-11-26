#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo 'Usage: checkout-onnx-source.sh <destination> <commit> <version>' >&2
  exit 2
fi
destination=$1
onnx_commit=$2
version=$3
upstream=https://github.com/microsoft/onnxruntime.git
[[ "$onnx_commit" =~ ^[0-9a-f]{40}$ && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2

# Do not inherit private checkout credentials or arbitrary Git configuration.
public_git() {
  env -i PATH="$PATH" HOME="$HOME" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false \
    git -c credential.helper= -c http.extraHeader= \
    -c 'url.https://github.com/.insteadOf=git@github.com:' \
    -c 'url.https://github.com/.insteadOf=ssh://git@github.com/' "$@"
}

mkdir "$destination"
public_git -C "$destination" init --quiet --template=
public_git -C "$destination" remote add origin "$upstream"

# Some servers allow advertised refs but reject direct SHA fetches. Neither fallback
# is trusted until its peeled commit matches the immutable source pin.
fetch_pinned() {
  local ref=$1
  if ! public_git -C "$destination" fetch --no-tags --depth=1 origin "$ref"; then
    return 1
  fi
  local actual
  actual=$(public_git -C "$destination" rev-parse 'FETCH_HEAD^{commit}') || return 1
  if [ "$actual" != "$onnx_commit" ]; then
    echo "Rejecting $ref: expected $onnx_commit, got $actual" >&2
    return 1
  fi
  public_git -C "$destination" checkout --quiet --detach "$actual"
}

if ! fetch_pinned "$onnx_commit" && ! fetch_pinned "refs/tags/v$version" && ! fetch_pinned "refs/heads/rel-$version"; then
  # Print public endpoint status only; never print response bodies or auth headers.
  for endpoint in \
    'https://api.github.com/repos/microsoft/onnxruntime' \
    "https://api.github.com/repos/microsoft/onnxruntime/commits/$onnx_commit" \
    "$upstream/info/refs?service=git-upload-pack"; do
    status=$(curl -q --silent --show-error --location --max-time 20 --output /dev/null --write-out '%{http_code}' "$endpoint") || status=unreachable
    printf 'ONNX upstream probe: %s -> %s\n' "$endpoint" "$status" >&2
  done
  echo "Unable to obtain the pinned ONNX Runtime commit $onnx_commit from the official upstream" >&2
  exit 1
fi

test "$(public_git -C "$destination" rev-parse HEAD)" = "$onnx_commit"
test "$(cat "$destination/VERSION_NUMBER")" = "$version"
public_git -C "$destination" submodule update --init --recursive --depth=1
submodule_status=$(public_git -C "$destination" submodule status --recursive)
if printf '%s\n' "$submodule_status" | grep -Eq '^[+-U]'; then
  echo 'ONNX Runtime source submodules are missing or differ from the pinned commit' >&2
  exit 1
fi
