---
title: 在游戏里用
description: 用外置登录进服，以及让 CustomSkinLoader 之类的皮肤 Mod 显示站点上的材质。
sidebar:
  order: 2
---

皮肤站做两件互不相干的事，可以只用其中一件：

- **外置登录**：游戏账号由站点认证，服务器不再用 Mojang 的会话。
- **皮肤 Mod**：客户端从站点取材质，和怎么登录没有关系。

## 外置登录

外置登录要游戏服务器和玩家的启动器两边都配好。下面的 `https://skin.example.com` 换成你的站点地址。

### 启动器（玩家）

在启动器里添加认证服务器，地址填 `https://skin.example.com/api/yggdrasil`（路径固定是 `/api/yggdrasil`）。HMCL、PCL2、BakaXL 等支持“外置登录 / authlib-injector”的启动器都能直接填；站点默认在响应头里指明这个路径，所以多数启动器只填站点地址也能识别。

填对之后，在启动器里登录站点账号就能看到站点上的角色，进服时服务器拿到的 UUID 来自站点。启动器会自己给游戏加上 authlib-injector，不用手写 JVM 参数。

### 游戏服务器（服主）

1. 下载 [authlib-injector](https://github.com/yushijinhun/authlib-injector/releases)，在服务器的启动命令里加上它：

   ```bash
   java -javaagent:authlib-injector.jar=https://skin.example.com/api/yggdrasil -jar server.jar
   ```

2. `server.properties` 里保持 `online-mode=true`。服务器靠这一项向站点核实玩家的身份；设成 `false` 就是离线模式，谁都能冒用别人的角色名进服。
3. 用 BungeeCord、Velocity 这类代理时，`-javaagent` 加在代理上，代理开着正版验证；后端服务器照代理的文档设成 `online-mode=false` 并开启转发。

## 皮肤 Mod

站点提供三种取材质的接口，按你用的 Mod 选：

| Mod / 接口 | 地址 |
|---|---|
| CustomSkinLoader 13.1+（CustomSkinAPI） | `https://skin.example.com/` |
| CustomSkinLoader 旧版、传统加载方式 | `https://skin.example.com/skin/*.png`、`https://skin.example.com/cape/*.png` |
| UniSkinMod（USM） | `https://skin.example.com/usm` |

### CustomSkinLoader 13.1 及以上

编辑 `.minecraft/CustomSkinLoader/CustomSkinLoader.json`，把站点放在 `loadlist` 最前面：

```json
{
  "enable": true,
  "loadlist": [
    { "name": "NextSkin", "type": "CustomSkinAPI", "root": "https://skin.example.com/" },
    { "name": "Mojang", "type": "MojangAPI" }
  ]
}
```

`root` 末尾要留斜杠。

### 旧版 CustomSkinLoader（12.9 及以下）

在 `.minecraft/CustomSkinLoader/skinurls.txt` 第一行写：

```
https://skin.example.com/skin/*.png
```

在 `capeurls.txt` 里加：

```
https://skin.example.com/cape/*.png
```

站点保留了这两条旧路径，老 Mod 也能直接取图。

### UniSkinMod

在 `.minecraft/config/UniSkinMod/UniSkinMod.json` 的 `rootURIs` 里加 `https://skin.example.com/usm`。

## 不显示皮肤时

1. 打开 `https://skin.example.com/<角色名>.json`，应该得到类似：

   ```json
   { "username": "Steve", "skins": { "default": "<hash>" }, "cape": null }
   ```

   `/csl/<角色名>.json` 也可以。

2. 用返回的 hash 打开 `https://skin.example.com/textures/<hash>`，能看到图片说明站点这边没问题。
3. 剩下的是客户端：看 `.minecraft/CustomSkinLoader/CustomSkinLoader.log` 里的 `ERROR`，确认 Mod 已加载、`loadlist` 顺序和 `root` 都对。
4. 角色名要和站点上的完全一致。角色名是 Minecraft 的玩家名，不是登录用的邮箱。

更多站点侧的问题见[常见问题](/guide/faq/)。
