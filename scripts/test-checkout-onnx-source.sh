#!/usr/bin/env bash
# Offline transport fixtures: exercise real Git checkout/submodule verification.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/code-atlas-onnx-checkout.XXXXXX")
trap 'rm -rf "$root"' EXIT
real_git=$(command -v git)
mkdir "$root/bin"
printf '%s\n' "$real_git" > "$root/bin/real-git"

fixture_commit() {
  "$real_git" -C "$1" -c user.name='ONNX checkout test' -c user.email='test@example.invalid' -c commit.gpgsign=false commit -qm "$2"
}
"$real_git" init -q --template= "$root/submodule"
printf 'pinned submodule\n' > "$root/submodule/payload"
"$real_git" -C "$root/submodule" add payload
fixture_commit "$root/submodule" submodule
"$real_git" init -q --template= "$root/source"
printf '1.30.0\n' > "$root/source/VERSION_NUMBER"
"$real_git" -C "$root/source" -c protocol.file.allow=always submodule add -q "$root/submodule" dependency
"$real_git" -C "$root/source" add VERSION_NUMBER .gitmodules dependency
fixture_commit "$root/source" source
pin=$("$real_git" -C "$root/source" rev-parse HEAD)
"$real_git" -C "$root/source" tag v1.30.0
"$real_git" -C "$root/source" branch rel-1.30.0

"$real_git" init -q --template= "$root/wrong"
printf '1.30.0\n' > "$root/wrong/VERSION_NUMBER"
"$real_git" -C "$root/wrong" add VERSION_NUMBER
fixture_commit "$root/wrong" wrong
"$real_git" -C "$root/wrong" tag v1.30.0
"$real_git" -C "$root/wrong" branch rel-1.30.0

# Replace only the top-level network fetch with a local repository; keep the
# checkout script's actual Git commands, source checks and submodule update.
cat > "$root/bin/git" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
bin=$(cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname "$bin")
real_git=$(cat "$bin/real-git")
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[i]}" == fetch && "${args[i+1]:-}" == --no-tags && "${args[i+2]:-}" == --depth=1 ]]; then
    remote=${args[i+3]}
    case "$remote" in
      origin|approved-mirror)
        printf '%s %s\n' "$remote" "${args[i+4]}" >> "$root/fetches"
        source=$(cat "$root/$remote-mode")
        [[ "$source" != unavailable ]] || exit 1
        args[i+3]="file://$root/$source"
        break
        ;;
    esac
  fi
done
exec "$real_git" -c protocol.file.allow=always "${args[@]}"
WRAPPER
cat > "$root/bin/curl" <<'WRAPPER'
#!/usr/bin/env bash
printf '404'
WRAPPER
chmod +x "$root/bin/git" "$root/bin/curl"
export PATH="$root/bin:$PATH"
mirror=https://github.com/approved-owner/onnxruntime.git
run_checkout() {
  CODE_ATLAS_ONNX_SOURCE_MIRROR=$1 bash "$script_dir/checkout-onnx-source.sh" "$root/$2" "$pin" 1.30.0 > "$root/$2.log" 2>&1
}
expect_failure() {
  if run_checkout "$1" "$2"; then
    echo "Expected checkout to fail: $2" >&2
    exit 1
  fi
}
verify_checkout() {
  [[ $("$real_git" -C "$root/$1" rev-parse HEAD) == "$pin" ]]
  [[ $("$real_git" -C "$root/$1" remote get-url origin) == https://github.com/microsoft/onnxruntime.git ]]
  [[ $("$real_git" -C "$root/$1/dependency" rev-parse HEAD) == $("$real_git" -C "$root/submodule" rev-parse HEAD) ]]
}

printf 'source\n' > "$root/origin-mode"
printf 'unavailable\n' > "$root/approved-mirror-mode"
run_checkout "$mirror" official
verify_checkout official
if grep -q '^approved-mirror ' "$root/fetches"; then
  echo 'Unexpected fallback after successful official fetch' >&2
  exit 1
fi
printf 'PASS official source preferred\n'

printf 'unavailable\n' > "$root/origin-mode"
printf 'source\n' > "$root/approved-mirror-mode"
run_checkout "$mirror" recovered
verify_checkout recovered
printf 'PASS exact approved mirror with pinned submodule\n'

printf 'wrong\n' > "$root/approved-mirror-mode"
expect_failure "$mirror" wrong-pin
grep -q 'Approved mirror could not provide the exact' "$root/wrong-pin.log"
[[ ! -e "$root/wrong-pin/VERSION_NUMBER" ]]
printf 'PASS wrong commit rejected even with matching release refs\n'

expect_failure '' no-mirror
grep -q 'ONNX upstream probe:' "$root/no-mirror.log"
printf 'PASS outage without approved source remains blocked\n'

expect_failure 'https://user:password@github.com/owner/repo.git' invalid
[[ ! -e "$root/invalid" ]]
printf 'PASS credential-bearing mirror rejected\n'

printf 'source\n' > "$root/approved-mirror-mode"
mv "$root/submodule" "$root/unavailable-submodule"
expect_failure "$mirror" missing-submodule
printf 'PASS missing pinned submodule remains blocked\n'
