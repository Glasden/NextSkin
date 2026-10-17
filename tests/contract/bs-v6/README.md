# BS v6 录制环境

一个真实的 Blessing Skin Server，用来录制协议契约用例（ADR-0001：BS v6 的行为是 Minecraft 协议兼容性的唯一判据），也可以作为导入器的源数据库（ADR-0006）。

| 组件 | 版本 |
|---|---|
| Blessing Skin Server | 6.0.2（最新正式版） |
| yggdrasil-api / usm-api / legacy-api | 5.2.1 / 1.2.3 / 1.1.3（默认启用） |
| yggdrasil-connect | 6.2.0（与 yggdrasil-api 互斥，按需切换） |
| PHP / nginx / MySQL | 8.1-fpm / 1.28 / 8.4 |

发行包和插件在构建镜像时按 `Dockerfile` 里写死的版本下载并校验 sha256。插件版本取自 `bs-community/plugins-dist` 的 `registry_en.json`。nginx 配置与官方 `bs-community/docker` 一致。

## 使用

```bash
docker compose -f tests/contract/bs-v6/compose.yaml up -d --build --wait   # 第一次构建约 1 分钟
docker compose -f tests/contract/bs-v6/compose.yaml down                   # 数据全部丢弃
```

- 站点 <http://127.0.0.1:38080>，超级管理员 `admin@nextskin.test` / `nextskin-test`。
- 数据库 `127.0.0.1:38306`，库名、用户名、密码都是 `blessingskin`。
- 第一次启动时由 `entrypoint.sh` 执行 `bs:install` 并启用插件。数据库在 tmpfs 里，上传的材质在容器里，所以 `down` 之后再 `up` 就是一个全新的实例。不要只重启 `db`：那样数据库会被清空，app 却仍然认为已经安装过。
- 录制 Yggdrasil Connect 插件的行为：`down` 之后用 `BS_YGGDRASIL_PLUGIN=yggdrasil-connect docker compose … up -d --wait` 启动。它的 OpenID Connect 部分还需要另外部署 Janus（bs-community/janus），这里没有。

## 录制

`pnpm --filter @nextskin/contract-tests record` 会清空这个实例里除超级管理员以外的数据，写入契约用例的固定数据后录制，见 `../README.md`。

## 录制时要注意

- yggdrasil-api 的 UUID 算法默认是 `v3`，由角色名决定，所以重建实例后 UUID 不变。RSA 签名密钥则是每次启用插件时随机生成的，带签名的响应要用 `/api/yggdrasil` 返回的公钥验证，不能逐字节比对。
- 官方的 Apache `.htaccess` 会把末尾带斜杠的路径 301 跳转，nginx 配置不会。末尾带斜杠的请求不能作为契约用例。
- 导入器要注意：yggdrasil-connect 重新设计了 `uuid` 表，关联字段从 `name` 改为 `pid`，并加了唯一约束（从 yggdrasil-api 迁移过来的站点要运行 `yggc:fix-uuid-table`）。两种结构都可能遇到。
