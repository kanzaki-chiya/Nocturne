#!/bin/bash
set -euo pipefail

app=${1:?expected absolute path to Nocturne.app}
shot=${2:?expected screenshot path}
home=$(mktemp -d)
binary="$app/Contents/MacOS/nocturne-desktop"
node="$app/Contents/Resources/node/node"
[[ -x "$binary" && -x "$node" ]]
shell_pid=''
nodes=()
cleanup() {
  if [[ -n "$shell_pid" ]]; then kill -9 "$shell_pid" 2>/dev/null || :; fi
  for pid in "${nodes[@]+"${nodes[@]}"}"; do
    if [[ "$(ps -p "$pid" -o comm= || :)" == "$node" ]]; then kill -9 "$pid" 2>/dev/null || :; fi
  done
}
trap cleanup EXIT
NOCTURNE_HOME="$home" env -u NOCTURNE_NODE "$binary" &
shell_pid=$!
sleep 20
kill -0 "$shell_pid"
while read -r pid; do
  if [[ "$(ps -p "$pid" -o comm= || :)" == "$node" ]]; then nodes+=("$pid"); fi
done < <(pgrep -P "$shell_pid" || :)
((${#nodes[@]} > 0)) || { echo "No bundled Node child of $shell_pid" >&2; exit 1; }
echo "shell=$shell_pid bundled-node=${nodes[*]}"
screencapture -x "$shot" || echo "screencapture unavailable"
kill -9 "$shell_pid"
wait "$shell_pid" 2>/dev/null || :
shell_pid=''
deadline=$((SECONDS + 10))
while :; do
  alive=0
  for pid in "${nodes[@]}"; do
    if [[ "$(ps -p "$pid" -o comm= || :)" == "$node" ]]; then alive=1; fi
  done
  ((alive == 0)) && break
  ((SECONDS < deadline)) || { echo "Bundled Node outlived shell" >&2; exit 1; }
  sleep 0.2
done
