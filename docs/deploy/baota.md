# 宝塔面板

实测宝塔 13.0 的"网站 → Node 项目"（Node 24）：启动、停止、重启。测试机没有装 nginx，反向代理那一节只读了模板（`/www/server/panel/vhost/template/nginx/node_http.conf`）和面板源码（`class/projectModel/nodejsModel.py`），未实测。公共部分见 [README.md](README.md)。

## 面板的行为

- "启动选项"列出 `package.json` 里的脚本，选 `start` 就是 `npm run start`，不经过 pm2。发行目录没有依赖，不用装 `node_modules`。
- 每次启动前 `chown -R` 项目目录给"运行用户"（默认 `www`）。
- 项目设置里的"环境变量"不会传给进程，"端口"只用于 nginx 反向代理和放行防火墙。端口、监听地址只能写进 `.env`。
- 停止：给进程树里的每个进程发一次 SIGTERM，不等退出、不发 SIGKILL。重启是停止后立即启动，新的 `start` 会等旧的放开数据目录（最多 40 秒），不用另外处理。
- 项目名只能用字母、数字、下划线。"外网映射"要先装 nginx 或 Apache。

## 步骤

1. 软件商店装 Node.js 版本管理器，装 Node 26（没有就装 24 以上）；装 nginx。
2. 把 `nextskin-<版本>.zip` 解压到 `/www/wwwroot`，得到 `/www/wwwroot/nextskin`。
3. 在项目目录写 `.env`（`.env` 存在时必须带 `NEXTSKIN_SECRET`，否则启动失败，退出码 78）：

   ```bash
   cd /www/wwwroot/nextskin
   printf 'NEXTSKIN_SECRET=%s\nNEXTSKIN_HOST=127.0.0.1\nNEXTSKIN_PORT=3000\n' "$(openssl rand -hex 32)" > .env
   chmod 600 .env
   ```

   备份这个文件。
4. "添加 Node 项目"：项目目录 `/www/wwwroot/nextskin`，启动选项 `start`，端口填和 `.env` 一样的 `3000`，运行用户 `www`，环境变量留空；填域名并开启外网映射。
5. 启动项目，改反向代理配置（下一节）。要用 HTTPS 就先配好 SSL：建站时的"站点地址"默认取当前打开的地址。
6. 打开 `https://域名/setup`，安装码：`cat /www/wwwroot/nextskin/data/setup-code`。

## 反向代理（未实测）

面板生成的 `/www/server/panel/vhost/nginx/node_<项目名>.conf` 里，`location /` 写的是：

```nginx
proxy_set_header Host $host:$server_port;
```

而且不带 `X-Forwarded-Proto`。HTTPS 站点会被算成 `http://域名:443`，外置登录的地址和材质地址都错。在 `location /` 里改成：

```nginx
proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
client_max_body_size 12m;
```

其余行（`X-Real-IP`、`X-Forwarded-For`、`X-Host`、`X-Scheme`、`Upgrade`）不用动。保存后重载 nginx，按 README 的"检查"核对 `X-Authlib-Injector-API-Location`。

- **面板会覆盖这个文件**：添加项目、修改项目设置、添加或删除域名、开关外网映射时都按模板重新生成，手改的内容会丢。做完这些操作后重新改一遍。申请或更换 SSL 证书是否也会覆盖，没有核对，换完也检查一遍。
- 想一劳永逸，可以改模板 `/www/server/panel/vhost/template/nginx/node_http.conf` 里对应的行（模板里写的是 `{host}:$server_port`），但会影响这台机器上所有 Node 项目，面板升级也可能还原它。
- 模板里禁止访问的文件和目录（`.env`、`*.log`、`README.md`、`/node_modules/`、`/.next/` 等）和 NextSkin 的路由不冲突。
- nginx 和 NextSkin 在同一台机器上，受信任的反向代理用默认值即可。

## 命令行

用运行用户执行：

```bash
sudo -u www node /www/wwwroot/nextskin/nextskin.mjs doctor
```

`node` 不在 PATH 里时，用版本管理器装的 Node 的绝对路径：`/www/server/nodejs/<版本>/bin/node`。
