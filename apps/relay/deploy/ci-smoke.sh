#!/usr/bin/env bash
set -euo pipefail

# 从仓库根目录运行；构建上下文只有 tgz，Dockerfile 来自仓库绝对路径。
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
dockerfile="$root/apps/relay/deploy/Dockerfile"
version="$(node -p "require('$root/apps/relay/package.json').version")"
tgz="$root/dist/relay/nocturne-relay-$version.tgz"
test -f "$tgz"
context="$(mktemp -d)"
name="nocturne-relay-smoke-$$"
volume="nocturne-relay-smoke-$$"
image="nocturne-relay:smoke-$$"
invite=""
code=""
container_started=false

safe_logs() {
    local logs
    logs="$(docker logs "$name" 2>&1)" || return 0
    if { [[ -n "$invite" ]] && grep -Fq -- "$invite" <<< "$logs"; } ||
       { [[ -n "$code" ]] && grep -Fq -- "$code" <<< "$logs"; }; then
        echo '容器日志包含邀请码明文或原始 code，拒绝打印' >&2
        return 1
    fi
    printf '%s\n' "$logs"
}
cleanup() {
    local status=$?
    trap - EXIT
    if [[ $status -ne 0 && "$container_started" == true ]]; then
        safe_logs || true
    fi
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null 2>&1 || true
    rm -rf -- "$context"
    exit "$status"
}
trap cleanup EXIT

cp -- "$tgz" "$context/relay.tgz"
node_version="$(node -p "require('$root/scripts/node-version.json').version")"
grep -Fxq "FROM node:$node_version-bookworm-slim" "$dockerfile"
docker build -f "$dockerfile" --build-arg RELAY_TGZ=relay.tgz -t "$image" "$context"
docker volume create "$volume" >/dev/null
docker run -d --name "$name" -p 127.0.0.1:8787:8787 \
    -e NOCTURNE_RELAY_PUBLIC_ORIGIN=http://127.0.0.1:8787 \
    -v "$volume:/data" "$image" >/dev/null
container_started=true

ready=false
for _ in $(seq 1 30); do
    if curl --fail --silent --output /dev/null http://127.0.0.1:8787/healthz; then
        ready=true
        break
    fi
    sleep 1
done
[[ "$ready" == true ]] || { echo '中继健康检查超时' >&2; exit 1; }
[[ "$(curl --fail --silent http://127.0.0.1:8787/healthz)" == ok ]]
curl --fail --silent http://127.0.0.1:8787/v1/info | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);if(d.protocol!==1||!d.relayVersion||!d.vapidPublicKey)process.exit(1)})'
curl --fail --silent http://127.0.0.1:8787/ | grep -Fq 'manifest.webmanifest'
curl --fail --silent http://127.0.0.1:8787/manifest.webmanifest | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);if(d.name!=="Nocturne"||d.start_url!=="/")process.exit(1)})'

invite="$(docker exec "$name" nocturne-relay invite create --note smoke-persist)"
code="${invite##*/}"
[[ "$invite" == "nocturne-invite:127.0.0.1:8787/"* && "$code" =~ ^[A-Za-z0-9_-]{24}$ ]]
docker restart "$name" >/dev/null
ready=false
for _ in $(seq 1 30); do
    if curl --fail --silent --output /dev/null http://127.0.0.1:8787/healthz; then
        ready=true
        break
    fi
    sleep 1
done
[[ "$ready" == true ]] || { echo '重启后健康检查超时' >&2; exit 1; }
list="$(docker exec "$name" nocturne-relay invite list)"
grep -Fq 'smoke-persist' <<< "$list"
if grep -Fq -- "$code" <<< "$list" || grep -Fq -- "$invite" <<< "$list"; then
    echo '邀请列表泄露邀请码明文' >&2
    exit 1
fi
safe_logs
stop_started=$SECONDS
docker stop -t 10 "$name" >/dev/null
(( SECONDS - stop_started <= 10 )) || { echo '停止超过 10 秒' >&2; exit 1; }
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$name")"
[[ "$exit_code" == 0 ]] || { echo "容器停止异常（ExitCode=$exit_code）" >&2; exit 1; }
safe_logs
echo '中继 Docker 冒烟通过（正常停止 ExitCode=0）'
