# NextSkin {{version}}

需要 Node 24 或更新版本，推荐 Node 26；不需要安装依赖。

1. 解压发行包，进入 `nextskin/` 目录，运行 `node nextskin.mjs start`。
2. 第一次启动会生成 `.env`，请备份它；打开 `http://<服务器地址>:3000/setup` 建站，安装码在 `data/setup-code`。

运行 `node nextskin.mjs help` 查看命令，`node nextskin.mjs doctor` 检查运行环境。

升级：停服务，备份 `data/` 和 `.env`，删掉 `server/` 和 `cli/`，解压新包覆盖，再启动。
升级后不能回到旧版本。SQLite 站点执行迁移之前会自动把库备份到 `data/backups/`（留最近 3 份）；MySQL、PostgreSQL 请先自己备份。
回退：停服务，换回旧版本的程序，把备份复制成 `data/nextskin.sqlite`，并删掉旁边的 `nextskin.sqlite-wal`、`nextskin.sqlite-shm`。

[部署文档（宝塔、1Panel、Docker、systemd、Windows）](https://github.com/Glasden/NextSkin/tree/main/docs/deploy)
