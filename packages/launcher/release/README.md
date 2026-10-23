# NextSkin {{version}}

需要 Node 24 或更新版本，推荐 Node 26；不需要安装依赖。

1. 解压发行包，进入 `nextskin/` 目录，运行 `node nextskin.mjs start`。
2. 第一次启动会生成 `.env`，请备份它；打开 `http://<服务器地址>:3000/setup` 建站，安装码在 `data/setup-code`。

运行 `node nextskin.mjs help` 查看命令，`node nextskin.mjs doctor` 检查运行环境。

程序按版本放在 `releases/<版本>/` 里，`releases/current.json` 指向在用的版本。

升级：在后台的“更新”页一键升级，或者运行 `node nextskin.mjs update`。也可以手动：停服务，备份 `data/` 和 `.env`，把新的 ZIP 覆盖解压到这个目录，再启动。
新版本没起来时会自动换回旧版本；SQLite 站点执行迁移之前会自动把库备份到 `data/backups/`。MySQL、PostgreSQL 有迁移时请先自己备份，升级前要确认。
回滚：在“更新”页，或者运行 `node nextskin.mjs rollback`，回到上一个版本。

[部署文档（宝塔、1Panel、Docker、systemd、Windows）](https://github.com/Glasden/NextSkin/tree/main/docs/deploy)
