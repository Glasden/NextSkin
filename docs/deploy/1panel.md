# 1Panel

实测 1Panel v2.4.0 的"网站 → 运行环境 → Node.js"（Node 24.15.0）：迁移、建站页、健康检查、停止。经 1Panel 网站（OpenResty）的反向代理未实测。公共部分见 [README.md](README.md)。

## 面板的行为

- 运行环境是一个 `1panel/node` 容器，接在 `1panel-network` 上。代码目录挂到容器的 `/app`；`.env` 和 `data/` 都在代码目录里，删掉、重建运行环境后还在。
- 应用商店里的 Node 只到 25.9.0，没有 26：plugin host 拦不住插件直接连网（`start` 会提示）。
- 容器的 PID 1 是 `bash /run.sh`，它用 `eval` 执行启动命令。默认的 `npm run <脚本>` 跑在 bash 下面，停止时 bash 不转发 SIGTERM，10 秒后整个容器被 SIGKILL，NextSkin 来不及收尾。所以启动命令要用 `exec`，让启动器替换 bash 成为 PID 1。
- "环境变量"会传给进程（写进容器的 compose）。
- 端口映射的主机 IP 默认 `0.0.0.0`。Docker 发布的端口绕过 ufw。
- 安装 1Panel 会在 ufw 里放行面板端口；运行后还出现带 `1panel-rule` 注释、对所有来源放行 80、443 的规则，卸载时不删。

## 步骤

1. 把 `nextskin-<版本>.zip` 解压到代码目录，例如 `unzip nextskin-<版本>.zip -d /opt`，得到 `/opt/nextskin`。
2. 创建 Node.js 运行环境：
   - 代码目录 `/opt/nextskin`；Node 版本选最新的；
   - 启动命令选"自定义"，填 `exec node nextskin.mjs start`；
   - 关掉"安装依赖"，否则每次启动都跑一遍 `npm install`；
   - 端口：容器端口 `3000`，主机端口自选，主机 IP 改成 `127.0.0.1`；
   - 环境变量不用填：第一次启动在代码目录生成 `.env`（含 `NEXTSKIN_SECRET`），备份它。容器里的监听地址要保持默认的 `0.0.0.0`，不要设 `NEXTSKIN_HOST=127.0.0.1`。
3. 建一个反向代理网站指向 `http://127.0.0.1:<主机端口>`，配 SSL，再按下一节核对。
4. 打开 `https://域名/setup`，安装码：`cat /opt/nextskin/data/setup-code`。

## 反向代理（未实测）

- 打开网站的配置文件，`location /` 里要有 README"反向代理"一节的几行：`Host` 和玩家请求里的一致（`$http_host`；网站在标准的 80、443 端口上时 `$host` 也行），有 `X-Forwarded-Proto $scheme`，`client_max_body_size` 至少 `12m`。改完按 README 的"检查"核对 `X-Authlib-Injector-API-Location`。
- 受信任的反向代理：OpenResty 经发布的端口连进来，NextSkin 看到的对端多半是 `1panel-network` 的网关（`docker network inspect 1panel-network` 里的 Gateway）。按 README 的方法看审计日志里的 IP 确认，再加进去。

## 命令行

在容器里执行（容器名见运行环境的详情或 `docker ps`）：

```bash
docker exec <容器名> node /app/nextskin.mjs doctor
```

## 升级（一键升级未实测）

- 后台"更新"页能一键升级：代码目录挂进容器、可写，启动命令是 `exec node nextskin.mjs start`，管理进程是 PID 1，升级时容器不重建。
- Node 版本由运行环境的镜像决定。新版本提高了 Node 的下限时预检会拦下：先在面板里把运行环境换成新的 Node 版本（会重建容器，代码目录不受影响），再升级。
- 手动升级：在面板里停止运行环境 → 备份 → 把新的 ZIP 覆盖解压到代码目录 → 启动。
- 命令行的 `update`、`rollback` 也在容器里执行：`docker exec <容器名> node /app/nextskin.mjs update status`。
