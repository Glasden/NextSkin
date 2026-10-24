---
title: 常见问题
description: 起不来、登录不上、皮肤不显示、上传失败等常见现象怎么排查。
sidebar:
  order: 4
---

先跑一次 `doctor`，它会把 Node 版本、密钥、数据目录、数据库和迁移状态、plugin host、服务是否在运行逐项列出来；有失败时退出码是 1。

```bash
node nextskin.mjs doctor
```

## 日志在哪

数据目录的 `logs/nextskin.log`，一行一条 JSON，带时间、级别和来源；超过上限就轮换成 `nextskin.1.log`、`nextskin.2.log`……，默认每份 10 MB、留 5 份，在后台“设置 → 高级”里调。面板的输出、journald、`docker logs` 里是同样的内容，每条一行文字。

超级管理员在后台的“诊断”页能直接看：顶部是版本、数据库、存储、插件进程和后台任务的摘要，下面是日志，可以按级别、来源和关键字筛选。报问题时在那里导出诊断包：里面有摘要、设置（机密项只记有没有设置）、设了哪些环境变量和最近的日志，邮箱、公网 IP、令牌和实例目录已经替换掉。替换是尽力而为，发出去之前先解压自己看一遍。

## 服务起不来

- **端口被占用**：默认 3000，用 `NEXTSKIN_PORT`（或 `PORT`）换一个。
- **提示 `NEXTSKIN_SECRET` 太短**：至少 32 个字符的随机串。首次启动会在发行目录生成 `.env`，丢了就删掉 `.env` 让它重新生成——但后台保存过的机密设置要重填。
- **提示数据目录写不了**：看 `doctor` 里的目录和当前用户。Docker 镜像以 uid 1000 运行，宝塔以 `www` 运行，`chown` 成对应用户即可。
- **改了代码想热更新**：`pnpm dev` 里改了 `packages/api`、`packages/domain` 要重启，核心和 Hono 应用缓存 `globalThis` 上换不掉。

## 打不开 /setup，或安装码不对

`/setup` 只在一个还没建站的空库上有效。建站成功后安装码文件会被删除，`/setup` 返回 404，这是正常的。安装码在数据目录的 `setup-code`，只有运行服务的用户能读。

## 站点地址填错会怎样

登录、注册会校验请求的 `Origin` 和“站点地址”一致；填错会出现登录后又跳回登录页、邮件链接打不开、通行密钥失效。反过来，改域名之后已有的通行密钥都不能再用，要重新注册。

默认留空时按请求推断；一旦填了，就要和玩家实际访问的地址完全一致（含协议和端口）。在后台“设置 → 站点 → 站点地址”改，或直接改 `site.url`。

## 上传材质报 413

反向代理的请求体上限太小。nginx 里加 `client_max_body_size 12m;`，然后 `nginx -s reload`（宝塔、1Panel 默认是 50 MB，不用改）。站点本身也限制单个文件大小，先确认不是超过了上限。

## 日志里的客户端 IP 都是代理地址

反向代理后面要配“受信任的反向代理”（`network.trustedProxies`），否则站点只看到代理的地址，限流和审计都会按代理算。怎么查代理的地址、怎么核对，见[反向代理与 HTTPS](/guide/install/reverse-proxy/#受信任的反向代理)。

## 忘了超级管理员密码 / 两步验证丢了

命令行可以在服务运行时直接改，操作者记为 `system`：

```bash
node nextskin.mjs set-role owner@example.com superadmin
node nextskin.mjs set-password owner@example.com
node nextskin.mjs disable-2fa owner@example.com
```

第一个超级管理员是 `/setup` 时创建的；后台自己改不了这个身份，只能用 `set-role`。命令细节见[命令行参考](/guide/commands/)。

## 验证码挡住登录

后台验证码配置错了，或者要临时关掉：`node nextskin.mjs disable-captcha`，也可以在后台把验证码提供方设为“无”。

## 邮件发不出去

`mail.transport` 默认是 `none`，邮箱验证、找回密码这些功能需要先在后台配 SMTP（服务器、端口、账号、发件地址）。自签证书的 SMTP 服务通常要允许不安全连接或换端口。

## 皮肤在游戏里不显示

按这个顺序查：

1. 浏览器打开 `https://你的站点/<角色名>.json`，能拿到 `skins` 里的 hash；
2. 打开 `https://你的站点/textures/<hash>`，能看到图片；
3. 两步都正常，问题在客户端的皮肤 Mod 配置，而不是站点。

具体配置和角色名对不上的排查见[在游戏里用](/players/client/)。注意角色名是 Minecraft 里的玩家名，不是站点账号。

## 外置登录提示“本站还没有配置签名密钥”

启动器登录失败，`/api/yggdrasil` 返回 400 和这句话：站点还没有签名私钥。它不会自动生成，建站以后由管理员在后台“设置 → Yggdrasil → 签名私钥”点“生成”，马上生效，见[生成签名私钥](/guide/install/#生成签名私钥)。

## 外置登录进不去

先确认后台已经[生成了签名私钥](/guide/install/#生成签名私钥)，再确认启动器里填的是 `https://你的站点/api/yggdrasil`，游戏服务器的启动命令带着 `-javaagent:authlib-injector.jar=https://你的站点/api/yggdrasil`，并且 `server.properties` 里是 `online-mode=true`（设成 `false` 是离线模式，不经过站点验证）。步骤见[在游戏里用](/players/client/#外置登录)。自签证书要先把证书装进客户端的信任库。

站点这边的地址算错了也会进不去：照[安装部署的“检查”](/guide/install/#检查)看 `X-Authlib-Injector-API-Location` 头，成了 `http://` 或带着 `:443`，就是反向代理少了 `Host`、`X-Forwarded-Proto` 那两行。宝塔默认生成的配置就是这样，见[宝塔面板](/guide/install/baota/#6-改反向代理配置)。

## 数据目录能放网络盘吗

SQLite 是单写锁、同步执行，放 NFS/SMB 这类网络盘会又慢又容易锁住；数据目录放本地盘。要多人同时写，换 MySQL 或 PostgreSQL。

## 升级失败了怎么回退

发行包：新版本没通过健康检查时，管理进程自己换回旧版本（SQLite 连同升级前的备份）；MySQL、PostgreSQL 有迁移而新版本起不来时不自动回滚，后台“更新”页写明要怎么做。升级成功以后想回去，在“更新”页或用 `node nextskin.mjs rollback` 回到上一个版本，见[升级与回退](/guide/upgrade/#回滚)。

Docker：标签改回旧版本；有迁移时先用 `/data/backups/` 里的备份换回库，步骤见 [Docker](/guide/install/docker/#升级与回退)。
