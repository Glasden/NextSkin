---
title: systemd
description: 在不装面板的 Linux 服务器上用 systemd 运行 NextSkin：专用用户、单元文件、权限分离和升级。
---

管理进程以 root 运行、只用来换版本，站点降到专用用户 `nextskin` 运行：站点被攻破也改不了程序目录，一键升级照样能用。前面的反向代理见[反向代理与 HTTPS](/guide/install/reverse-proxy/)。

## 安装

用系统级安装的 Node 26（发行版的包、NodeSource 或官方二进制）。装在某个用户家目录下的 Node（nvm 等），服务用户读不到。

```bash
sudo unzip nextskin-<版本>.zip -d /opt                  # 得到 /opt/nextskin，程序属于 root
sudo useradd --system --home-dir /opt/nextskin --shell /usr/sbin/nologin nextskin
sudo install -d -o nextskin -g nextskin /opt/nextskin/data
sudo sh -c 'umask 077; printf "NEXTSKIN_SECRET=%s\nNEXTSKIN_HOST=127.0.0.1\n" "$(openssl rand -hex 32)" > /opt/nextskin/.env'
sudo chown nextskin:nextskin /opt/nextskin/.env           # 备份这个文件
```

程序目录（`nextskin.mjs`、`manager/`、`releases/`）属于 root，服务用户只读；只有 `data/` 和 `.env` 属于它。`.env` 存在时必须带 `NEXTSKIN_SECRET`，否则启动以退出码 78 失败。

## 单元文件

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

然后经反向代理打开 `https://<域名>/setup` [建站](/guide/install/#建站)。

不想让 root 常驻：去掉 `Environment=NEXTSKIN_RUN_AS=…`，加上 `User=nextskin`、`Group=nextskin`。这时管理进程写不了 `releases/`，后台只检测新版本、不能一键升级，升级照下面的“手动升级”。

:::note
权限分离（管理进程 uid 0，启动器和核心降到 `nextskin`、附加组清空，控制通道的 socket 只有 root 和 `nextskin` 能连）在容器里以 root 实测过；这份单元文件下的一键升级和回滚实测过（0.6.0 和 0.7.1 之间来回，三层进程的用户、`data/` 的属主都对，重启服务后换上了新的管理进程），开机自启还没有实测。
:::

## 命令行

日常命令用服务用户运行，否则数据目录里会出现服务读写不了的文件：

```bash
sudo -u nextskin node /opt/nextskin/nextskin.mjs doctor
```

一键升级之后、重启服务之前，这样运行的命令会先打一行“没有换上新管理进程，继续使用旧版：EACCES”。新的管理进程放在 `manager.next/`，要等服务下次以 root 启动时换上，服务用户换不了。命令照常执行，`sudo systemctl restart nextskin` 一次之后就不再出现。

`update`、`rollback` 要读 root 的令牌、写 `releases/`，用 root 运行。服务停着时它们自己跑迁移，单元文件里的环境变量带不过来，要自己给上：

```bash
sudo node /opt/nextskin/nextskin.mjs update status
sudo NEXTSKIN_RUN_AS=nextskin node /opt/nextskin/nextskin.mjs update --yes   # 服务停着时
```

以 root 运行而没给 `NEXTSKIN_RUN_AS` 时，服务停着的 `update`、`rollback` 发现数据目录属于别的用户就拒绝（退出码 78）：root 跑的迁移会在 `data/` 里留下服务读写不了的文件。

## 升级

一键升级：后台“更新”页，或者 `sudo node /opt/nextskin/nextskin.mjs update`，见[升级与回退](/guide/upgrade/)。

手动升级：

```bash
sudo systemctl stop nextskin
# 备份 /opt/nextskin/data 和 /opt/nextskin/.env
sudo unzip -o nextskin-<新版本>.zip -d /opt             # 不会覆盖 .env 和 data/
sudo systemctl start nextskin
```

从 0.4 及更早的版本升级时，旧单元文件里的 `User=nextskin` 要换成上面的 `Environment=NEXTSKIN_RUN_AS=nextskin`（`sudo systemctl edit --full nextskin`，再 `daemon-reload`）；不换也能运行，只是不能一键升级。
