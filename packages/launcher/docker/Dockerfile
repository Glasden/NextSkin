# NextSkin 镜像（ADR-0040）：只把发布流程打好的发行目录复制进来，不在 Docker 里构建，两种架构的程序完全相同。
# 构建上下文是发行目录（ZIP 解压出来的 nextskin/）：
#   docker build -f packages/launcher/docker/Dockerfile -t nextskin dist/nextskin
# 不用 heredoc、COPY --chmod 这类 BuildKit 专有的写法，没有 buildx 的机器也能构建。
# 不用 alpine：Node 在 musl 上属于 experimental 支持层级。digest 由 Renovate 升级。
FROM node:26-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4

# tini 做 PID 1：把信号转给启动器，回收过继给它的孤儿进程（核心被强杀后留下的 plugin host）。
# 启动器本身做 PID 1 时不回收别人的子进程
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && printf '#!/bin/sh\nexec node /app/nextskin.mjs "$@"\n' > /usr/local/bin/nextskin \
  && chmod 755 /usr/local/bin/nextskin \
  && mkdir /data \
  && chown node:node /data

# 逐项复制发行目录，不复制整个上下文：本地运行过的发行目录里可能有 .env 和 data/。
# /app 属主是 root，运行时只读；密钥只从环境变量 NEXTSKIN_SECRET 给，没给时启动器生成不了 .env，以 78 退出
COPY nextskin.mjs package.json README.md .env.example /app/
COPY cli /app/cli
COPY server /app/server

# Docker 只检测更新，后台按镜像部署显示提示（ADR-0061）。
ENV NEXTSKIN_DEPLOYMENT=docker
ENV NEXTSKIN_DATA_DIR=/data NEXTSKIN_HOST=0.0.0.0
WORKDIR /app
USER node
VOLUME /data
EXPOSE 3000
# 镜像里没有 curl，用 Node 的 fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.NEXTSKIN_PORT || process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["tini", "--", "node", "/app/nextskin.mjs"]
CMD ["start"]
