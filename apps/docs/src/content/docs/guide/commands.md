---
title: 命令行
description: NextSkin 启动器的全部命令、参数、输出和退出码。
sidebar:
  order: 2
---

启动器 `nextskin` 负责进程监管和运维命令，站点本身不用登录后台也能管。这一页是完整参考。

## 在哪里运行

- **发行包**：在解压目录里运行 `node nextskin.mjs <命令>`。
- **源码**：在仓库根目录运行 `pnpm nextskin <命令>`。它读 `apps/web/.env` 和环境变量，数据目录与 `pnpm dev` 相同。

`start` 只能在发行目录里运行；其余命令在两种环境下都可用。

## 通用约定

**配置来源。** 启动器读发行目录下的 `.env`（可以用 `NEXTSKIN_ENV_FILE` 指到别的文件），已经存在的环境变量优先，不会被文件覆盖。

**首次启动生成密钥。** 发行目录里没有 `.env` 时，`start` 会写一份，里面有 `NEXTSKIN_SECRET`；它用来加密后台保存的机密设置，丢了就要全部重填。把这个文件备份好。也可以用环境变量直接给一个至少 32 个字符的随机串。

**执行者。** 命令不经过网页会话，操作者一律记为 `system`，照常写审计记录，IP 为空。所以命令不受后台的身份规则限制——`set-role` 能把人设成超级管理员，后台改不了这个身份。

**服务运行时也能执行。** 除 `import blessing-skin` 要求先停服务外，其余命令直接操作数据库和数据目录，运行中的服务会在几秒内跟上（插件状态最多 5 秒）。

**退出码。**

| 退出码 | 含义 |
|---|---|
| 0 | 成功，或者 `doctor` 只有警告 |
| 1 | 参数不对、检查失败、执行失败 |
| 2 | `import blessing-skin` 拿不到数据目录的锁：服务还在运行，或者目录权限不对 |
| 78 | 配置错误，例如 `NEXTSKIN_SECRET` 太短、端口不合法、数据目录写不了 |

## 命令一览

| 命令 | 作用 |
|---|---|
| [`start`](#start) | 启动并监管核心进程 |
| [`doctor`](#doctor) | 只读检查运行环境 |
| [`migrate`](#migrate) | 执行数据库迁移 |
| [`set-role`](#set-role) | 设定用户身份，包括超级管理员 |
| [`set-password`](#set-password) | 重设密码、收回账号 |
| [`disable-2fa`](#disable-2fa) | 关闭用户的两步验证 |
| [`disable-captcha`](#disable-captcha) | 关闭站点验证码 |
| [`maintenance`](#maintenance) | 查看或开关维护模式 |
| [`plugin`](#plugin) | 列出、安装、启用、停用、卸载插件 |
| [`import blessing-skin`](#import-blessing-skin) | 从 Blessing Skin v6 导入 |
| [`version`](#version) | 显示版本 |

不带命令、或者 `help`，会打印这份列表的简版。

## start

```bash
node nextskin.mjs start
```

启动核心进程并监管它：核心崩溃时按退避重启，收到停止信号时转发并等它退出。前台运行，日志写 stdout/stderr，交给 systemd、Docker 或面板托管。

- 启动前检查发行目录是否完整、数据目录能否写入，并打印版本、Node 版本、数据目录、数据库方言和监听地址。
- 同一个数据目录同时只能有一个 `start`。上一个实例没退干净时会等它退出，最多 40 秒。
- Node 24、25 下会提示 plugin host 拦不住插件直接连网，建议用 Node 26。
- 首次运行会生成 `.env` 和 `NEXTSKIN_SECRET`（见上文）。

## doctor

```bash
node nextskin.mjs doctor
```

只读检查，不会改数据。依次看 Node 版本、配置文件是否存在且权限合适、`NEXTSKIN_SECRET`、其余配置能否解析、数据目录能否写入和剩余空间、数据库连接与迁移状态、发行目录是否完整、plugin host 能否拉起、服务是否正在运行。

每项标为通过、警告、失败或跳过，最后汇总。有失败时退出码 1，只有警告时仍是 0。启动失败先跑它。

## migrate

```bash
node nextskin.mjs migrate
```

只执行数据库迁移，不启动服务。`start` 启动时也会自动迁移；这个命令用于部署前单独检查，或者迁移失败后重试。

## set-role

```bash
node nextskin.mjs set-role <邮箱> <身份>
```

身份是 `banned`、`user`、`admin`、`superadmin` 之一。第一个超级管理员在 `/setup` 建站时创建；之后后台动不了 `superadmin` 这个身份，要另指定或者转移就用这个命令。设为 `banned` 会封禁账号。

成功后输出昵称、UID 和新身份；邮箱没注册过或者格式不对会说明原因，不会回显数据库连接信息。

## set-password

```bash
node nextskin.mjs set-password <邮箱或 uid> [--remove-other-methods] [--email <新地址>]
```

超级管理员丢了密码、或者账号可能被别人控制时用它找回。新密码在终端里输入两次、不回显，不接受参数或管道——密码写进参数会留在 shell 历史和进程列表里。

按邮箱找不到人时可以按 UID 找。执行效果等于后台的“改密码 + 收回账号”，在一个事务里完成：

- 作废该用户全部网页登录和启动器登录，以及还没用的找回密码、改邮箱链接；
- `--remove-other-methods` 同时删掉全部通行密钥、解绑全部第三方账号，只留密码；
- `--email <新地址>` 立即把邮箱换成新地址，算已验证，不发确认邮件。

输出会说明退出了几个网页登录、几个启动器登录。

## disable-2fa

```bash
node nextskin.mjs disable-2fa <邮箱或 uid>
```

超级管理员丢了验证器、备用码也用完时用它。删掉验证器、备用码、还没完成的第二步和信任过的设备；不退出已有登录；站点配了邮件时通知对方。

## disable-captcha

```bash
node nextskin.mjs disable-captcha
```

把验证码服务商设为 `none`。验证码服务故障、密钥配错、管理员登录不了时用。之后注册、密码登录和找回密码都不再要验证码，恢复时在后台设置里重新选服务商。

## maintenance

```bash
node nextskin.mjs maintenance        # 查看当前状态
node nextskin.mjs maintenance on     # 开启
node nextskin.mjs maintenance off    # 关闭
```

开启后，除管理员外访问站点只能看到维护页。后台设置里的“维护时停用游戏服务”决定 Yggdrasil 等协议端点是否一起停：

- 开启时，输出会注明“游戏服务已停用”或“游戏服务照常”；
- 只影响网页入口和协议端点，不停止进程，也不需要重启。

## plugin

```bash
node nextskin.mjs plugin list
node nextskin.mjs plugin install <插件包.tgz> [--yes]
node nextskin.mjs plugin enable <id>
node nextskin.mjs plugin disable <id>
node nextskin.mjs plugin uninstall <id> [--yes]
```

不登录后台也能管插件，效果和后台插件页一致。操作者是 `system`，写审计记录。

- `install` 接受 `nextskin-plugin build` 生成的 `.tgz`，安装前打印插件声明的能力、网络、事件、拦截点、路由、数据表等清单，高风险能力会标出来。要确认，`--yes` 跳过。
- 安装后不会自动运行，还要 `enable`。启用时临时拉起一个只装这个插件的 plugin host，加载并跑完迁移才算成功。
- `disable` 保留插件的数据、设置和排队任务，重新启用后继续。
- `uninstall` 删掉插件的数据表和插件包，官方插件不能卸载，只能停用。清理由运行中的服务在 12 分钟后做；服务没运行就等下次启动。
- 服务运行时也能执行，运行中的服务每 5 秒同步一次插件表。

## import blessing-skin

```bash
node nextskin.mjs import blessing-skin --bs-env /path/to/old/.env --textures /path/to/textures
```

从 Blessing Skin v6 只读导入。**先停掉服务**：命令要独占数据目录的锁，拿不到就退出 2。

- `--from <地址>` 旧库连接串（`mysql://`、`postgres://` 或 `sqlite:<文件>`）；省略时从 `--bs-env` 的 `DB_*` 读取。推荐用 `--bs-env`，命令行参数会出现在进程列表里。
- `--bs-env <文件>` 旧站的 `.env`，读密码算法、盐、表前缀、材质目录和数据库连接。盐只能从这里或环境变量 `BS_SALT` 来，不能写在命令行。
- `--prefix`、`--textures`、`--timezone`、`--site-url` 覆盖旧站配置里的对应项。
- `--uuid-overrides <文件>` 用 JSON 逐个指定角色 UUID（`{ "<pid>": "<uuid>" }`），用于纠正已知的 UUID 映射错误。
- `--dry-run` 完整跑一遍并生成报告，最后回滚，不复制文件。第一次导入先跑它。
- `--replace` 目标库里有上一次导入的数据时，重新导入要加；`--force` 在导入后新站又产生了数据时仍继续（还要 `--replace`）。
- `--report <文件>` 报告位置，默认是数据目录下的 `import-<时间>.md`。

细节和导入后的核对步骤见[迁移指南](https://github.com/Glasden/NextSkin/blob/main/packages/importer/MIGRATION.md)。

## version

```bash
node nextskin.mjs version
```

打印启动器版本，和发行包里的版本一致。
