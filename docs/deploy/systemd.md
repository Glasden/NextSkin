# systemd

用临时单元（`systemd-run --user`，和下面的单元同样的 `KillMode`、`TimeoutStopSec`、`Restart`、`RestartPreventExitStatus`）实测过：

- 正常停止 46 毫秒，退出码 0；
- 强杀启动器后，systemd 清掉剩下的核心并重启，3 秒后恢复；
- 配置错误退出 78，单元停在 failed，不重启。

按下面的步骤和单元文件（`User=nextskin`）在 Ubuntu 24.04（systemd 255，arm64，Node 24.21）上实测过，程序用的是 `pnpm build` 出来的发行目录，没有经过 ZIP：

- 以服务用户运行的 `doctor` 没有失败项；
- `enable --now` 后约 2 秒健康检查返回 200，监听地址按 `.env` 只有 `127.0.0.1:3000`；
- `restart` 正常停止（`Deactivated successfully`）后重新启动，数据目录里的文件都属于 `nextskin`。

开机自启未实测。公共部分见 [README.md](README.md)。

上面的实测用的是 0.4 的布局（根目录直接是启动器）。0.4 之后的版本根目录的 `nextskin.mjs` 是管理进程（ADR-0061），单元文件改成下面的样子：管理进程以 root 运行，只用来换版本，站点照旧以 `nextskin` 运行。在容器里以 root 实测过这种权限分离：管理进程 uid 0，启动器和核心降到 `nextskin`、附加组清空；控制通道的 socket 是 `root:nextskin`、`0660`，别的用户连不上；`nextskin` 读不了令牌、写不了 `releases/`；停止退出码 0。systemd 单元本身、一键升级的全过程未实测。

## 安装

用系统级安装的 Node（发行版的包、NodeSource 或官方二进制）。装在某个用户家目录下的 Node（nvm 等），服务用户读不到。

```bash
sudo unzip nextskin-<版本>.zip -d /opt                  # 得到 /opt/nextskin，程序属于 root
sudo useradd --system --home-dir /opt/nextskin --shell /usr/sbin/nologin nextskin
sudo install -d -o nextskin -g nextskin /opt/nextskin/data
sudo sh -c 'umask 077; printf "NEXTSKIN_SECRET=%s\nNEXTSKIN_HOST=127.0.0.1\n" "$(openssl rand -hex 32)" > /opt/nextskin/.env'
sudo chown nextskin:nextskin /opt/nextskin/.env           # 备份这个文件
```

程序目录（`nextskin.mjs`、`manager/`、`releases/`）属于 root，服务用户只读；只有 `data/` 和 `.env` 属于它。`.env` 存在时必须带 `NEXTSKIN_SECRET`。

`/etc/systemd/system/nextskin.service`：

```ini
[Unit]
Description=NextSkin
After=network-online.target
Wants=network-online.target
# 数据库在同一台机器上时加上它，例如 After=mysql.service

[Service]
# 管理进程以 root 运行（降权要 CAP_SETUID），拉起站点时降到 nextskin：
# 站点被攻破也改不了程序目录，一键升级时管理进程照样能写 releases/
Environment=NEXTSKIN_RUN_AS=nextskin
WorkingDirectory=/opt/nextskin
# node 的绝对路径：command -v node
ExecStart=/usr/bin/node /opt/nextskin/nextskin.mjs start
# 只给管理进程发 SIGTERM，由它经 IPC 让启动器按顺序停核心和 plugin host；到时再强杀其余进程
KillMode=mixed
# 启动器最多等核心 30 秒
TimeoutStopSec=40
Restart=on-failure
# 78 是配置错误，重启没用
RestartPreventExitStatus=78

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nextskin
journalctl -u nextskin -f
sudo cat /opt/nextskin/data/setup-code
```

不想让 root 常驻：去掉 `Environment=NEXTSKIN_RUN_AS=…`，加回 `User=nextskin`、`Group=nextskin`。这时管理进程写不了 `releases/`，后台只检测、不一键升级，升级照下面的"手动升级"。

## 命令行

```bash
sudo -u nextskin node /opt/nextskin/nextskin.mjs doctor
```

`update`、`rollback` 要读 root 的令牌、写 `releases/`，用 root 运行。服务停着时它们自己跑迁移，单元文件里的环境变量带不过来，要自己给上：

```bash
sudo node /opt/nextskin/nextskin.mjs update status
sudo NEXTSKIN_RUN_AS=nextskin node /opt/nextskin/nextskin.mjs update --yes   # 服务停着时
```

以 root 运行而没给 `NEXTSKIN_RUN_AS` 时，服务停着的 `update`、`rollback` 发现数据目录属于别的用户就拒绝（退出码 78）：root 跑的迁移会在 `data/` 里留下服务读写不了的文件。

## 升级

一键升级：后台"更新"页，或者 `sudo node /opt/nextskin/nextskin.mjs update`。

手动升级：

```bash
sudo systemctl stop nextskin
# 备份 /opt/nextskin/data 和 /opt/nextskin/.env
sudo unzip -o nextskin-<新版本>.zip -d /opt             # 不覆盖 .env 和 data/
sudo systemctl start nextskin
```

从 0.4 及更早的版本升级时，旧单元文件里的 `User=nextskin` 要换成上面的 `Environment=NEXTSKIN_RUN_AS=nextskin`（`sudo systemctl edit --full nextskin`，再 `daemon-reload`）；不换也能运行，只是不能一键升级。
