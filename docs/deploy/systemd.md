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

## 安装

用系统级安装的 Node（发行版的包、NodeSource 或官方二进制）。装在某个用户家目录下的 Node（nvm 等），服务用户读不到。

```bash
sudo unzip nextskin-<版本>.zip -d /opt                  # 得到 /opt/nextskin，程序属于 root
sudo useradd --system --home-dir /opt/nextskin --shell /usr/sbin/nologin nextskin
sudo install -d -o nextskin -g nextskin /opt/nextskin/data
sudo sh -c 'umask 077; printf "NEXTSKIN_SECRET=%s\nNEXTSKIN_HOST=127.0.0.1\n" "$(openssl rand -hex 32)" > /opt/nextskin/.env'
sudo chown nextskin:nextskin /opt/nextskin/.env           # 备份这个文件
```

程序目录不给服务用户写权限，只有 `data/` 和 `.env` 属于它。`.env` 存在时必须带 `NEXTSKIN_SECRET`。

`/etc/systemd/system/nextskin.service`：

```ini
[Unit]
Description=NextSkin
After=network-online.target
Wants=network-online.target
# 数据库在同一台机器上时加上它，例如 After=mysql.service

[Service]
User=nextskin
Group=nextskin
WorkingDirectory=/opt/nextskin
# node 的绝对路径：command -v node
ExecStart=/usr/bin/node /opt/nextskin/nextskin.mjs start
# 只给启动器发 SIGTERM，由它按顺序停核心和 plugin host；到时再强杀其余进程
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

## 命令行

```bash
sudo -u nextskin node /opt/nextskin/nextskin.mjs doctor
```

## 升级

```bash
sudo systemctl stop nextskin
# 备份 /opt/nextskin/data 和 /opt/nextskin/.env
sudo rm -rf /opt/nextskin/server /opt/nextskin/cli
sudo unzip -o nextskin-<新版本>.zip -d /opt             # 不覆盖 .env 和 data/
sudo systemctl start nextskin
```
