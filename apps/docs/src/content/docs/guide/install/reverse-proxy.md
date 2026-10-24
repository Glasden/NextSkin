---
title: 反向代理与 HTTPS
description: 给 NextSkin 配 nginx 反向代理：必须带的请求头、上传大小、受信任的反向代理、缓存、CDN 和防火墙。
---

NextSkin 自己只说 HTTP，HTTPS 交给前面的反向代理。宝塔和 1Panel 会替你生成反向代理的配置，照各自页面的步骤核对就行；其余方式照这一页配。

## nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 12m;
}
```

- **`Host` 和 `X-Forwarded-Proto` 决定协议端点算出来的站点地址**：外置登录的 `X-Authlib-Injector-API-Location` 头、材质的地址都靠它们。`Host` 要和玩家请求里的一致：写成 `$host:$server_port`，HTTPS 站点会变成 `域名:443`；不带 `X-Forwarded-Proto` 会算成 `http://`。两样都错，外置登录的地址就成了 `http://skin.example.com:443/api/yggdrasil`。
- **`client_max_body_size`**：nginx 默认 1 MB，插件包最大 10 MB，材质默认 1 MB（后台可调）。太小时上传返回 413。
- 不需要 WebSocket、SSE。

配好以后照[安装部署的“检查”](/guide/install/#检查)核对 `X-Authlib-Injector-API-Location`。

## 证书

- 证书由反向代理管：Let's Encrypt（certbot、acme.sh、面板自带的申请）、买的证书、CDN 给的源站证书都行。
- 先配好 HTTPS 再[建站](/guide/install/#建站)：建站时的“站点地址”默认取你当时打开的地址。
- 自签证书只适合内网测试：玩家的启动器和游戏要先把证书装进 Java 的信任库，否则外置登录连不上。

## 受信任的反向代理

只有来自后台“设置 → 高级 → 受信任的反向代理”里这些地址的请求，NextSkin 才采信 `X-Forwarded-For` 里的客户端 IP。默认是 `127.0.0.0/8` 和 `::1`，同机的 nginx 不用改。

反向代理和 NextSkin 不在同一个网络命名空间里时（Docker、1Panel、另一台机器），NextSkin 看到的对端是网关或代理的地址，要把它加进去；否则所有访客共用一个 IP，按 IP 的注册限制和限流对所有人一起生效。`X-Forwarded-Proto` 不看这项设置。

**核对方法**：经反向代理登录后台，随便改一项设置再改回来，然后看“审计日志”里这两条记录的 IP。是你的公网 IP 就对了；是 `172.x`、`10.x` 这类地址，就把这个地址加进受信任的反向代理，再改一次设置核对。审计日志只记管理操作，不记登录，退出再登录看不到新记录。1Panel 页有[这一步的截图](/guide/install/1panel/#7-设置受信任的反向代理)。

## 缓存

能长期缓存的响应，NextSkin 自己带上了 `Cache-Control`：`/_next/static/` 下的脚本、样式和出图（`/render/…`，地址里带出图的版本）是一年的 `immutable`；材质文件按后台“设置 → 高级 → 公开资源的缓存时间”（默认一年）。浏览器和 CDN 照着缓存就够了，反向代理不用另外配。

不要用 `alias`、`root` 让 nginx 直接读程序目录或数据目录里的文件：

- `/_next/static/`：程序在 `releases/<版本>/` 里，路径每次升级都变。指向旧路径的配置在升级以后让全站的脚本和样式 404。
- `/textures/…`：NextSkin 只返回还在用的材质（删掉的材质，文件默认一小时以后才从磁盘上清掉），`ETag`、`Last-Modified` 也是协议约定的格式。直接读文件会把删掉的材质继续发出去，响应头和皮肤站模组、启动器期待的对不上，还得让 nginx 的用户能进数据目录。

想让 nginx 少回源，就用 `proxy_cache` 反代这两类路径、只缓存 200（在线上站点实测过）：

```nginx
# http 块里（proxy_cache_path 只能放在 http 上下文）
proxy_cache_path /var/cache/nginx/nextskin levels=1:2 keys_zone=nextskin:16m max_size=512m inactive=30d use_temp_path=off;
```

```nginx
# server 块里，和 location / 并列；/render/ 再写一段同样的
location /_next/static/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache nextskin;
    proxy_cache_valid 200 30d;
}
```

升级的那一刻，还开着旧页面的访客会请求旧版本的文件、得到 404；只缓存 200，这些 404 不会留在缓存里。

## CDN 和内容安全策略

页面带 `Content-Security-Policy` 响应头：只执行带本次请求 nonce 的脚本。反向代理和 CDN 不要去掉或改写这个头，也不要另加一条 CSP。往页面里插脚本、改写页面里的脚本的 CDN 功能会被它拦下，以 Cloudflare 为例：

- **Rocket Loader**、**邮箱地址混淆**（Scrape Shield 里的 Email Address Obfuscation）：关掉。它们改写页面里的脚本，不带 nonce，浏览器不执行；改写过的 HTML 还可能和页面的脚本对不上，按钮、表单失灵。
- **Bot Fight Mode**（JavaScript Detections）：可以开。Cloudflare 会读响应头里的 CSP，给它插的脚本带上同一个 nonce。
- **Web Analytics** 的自动注入：未实测。

## 防火墙

- 只给反向代理用的端口绑 `127.0.0.1`（发行包设 `NEXTSKIN_HOST=127.0.0.1`，Docker 发布成 `127.0.0.1:3000:3000`）。Docker 发布的端口绕过 ufw、firewalld。
- 面板装好后可能改过防火墙：1Panel 安装时放行面板端口，运行后还加了对所有来源放行 80、443 的规则（注释 `1panel-rule`），卸载时不删。已有自定义规则的服务器，装面板前后对比 `ufw status numbered`。
