#!/usr/bin/env bash
# 镜像冒烟测试（ADR-0040）：从发行目录构建镜像；没给密钥时以 78 退出；只读的根文件系统下启动到 healthy，
# 容器里的 nextskin doctor 全部通过，docker stop 之后退出码 0。CI 和发布工作流都跑它，本地：
#   bash packages/launcher/docker/smoke.sh dist/nextskin
set -euo pipefail
release=${1:?用法：smoke.sh <发行目录>}
image=nextskin:smoke
name=nextskin-smoke-$$
docker build -q -f "$(dirname "$0")/Dockerfile" -t "$image" "$release" >/dev/null
trap 'docker rm -fv "$name" >/dev/null 2>&1 || true' EXIT

code=0
docker run --rm "$image" || code=$?
if [ "$code" != 78 ]; then
  echo "没给密钥时应以 78 退出，实际是 $code" >&2
  exit 1
fi

# 密钥只经环境变量交给 docker，不出现在命令行和日志里
NEXTSKIN_SECRET=$(openssl rand -hex 32) docker run -d --name "$name" --read-only -e NEXTSKIN_SECRET "$image" >/dev/null
status=
for _ in $(seq 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$name")
  if [ "$status" = healthy ] || [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then break; fi
  sleep 1
done
if [ "$status" != healthy ]; then
  docker logs "$name"
  echo "60 秒内没有变成 healthy（$status）" >&2
  exit 1
fi
docker exec "$name" nextskin doctor
docker stop -t 40 "$name" >/dev/null
docker logs "$name"
code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
if [ "$code" != 0 ]; then
  echo "docker stop 之后退出码是 $code" >&2
  exit 1
fi
echo '镜像冒烟测试通过'
