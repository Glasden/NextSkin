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

1. 游戏服务器 `server.properties` 里设 `online-mode=false`。
2. 在启动器里添加认证服务器，地址填 `https://nextskin.org/api/yggdrasil`（换成你的站点地址，路径固定是 `/api/yggdrasil`）。HMCL、PCL2、BakaXL 等支持“外置登录 / authlib-injector”的启动器都能直接填。
3. 手动装 authlib-injector 时，JVM 参数是：

   ```bash
   -javaagent:authlib-injector.jar=https://nextskin.org/api/yggdrasil
   ```

   启动器一般会自己加，不用手写。

填对之后，启动器里登录站点账号就能看到站点上的角色，进服时服务器拿到的 UUID 来自站点。老版本客户端要用对应版本的 authlib-injector。

## 皮肤 Mod

站点提供三种取材质的接口，按你用的 Mod 选：

| Mod / 接口 | 地址 |
|---|---|
| CustomSkinLoader 13.1+（CustomSkinAPI） | `https://nextskin.org/` |
| CustomSkinLoader 旧版、传统加载方式 | `https://nextskin.org/skin/*.png`、`https://nextskin.org/cape/*.png` |
| UniSkinMod（USM） | `https://nextskin.org/usm` |

### CustomSkinLoader 13.1 及以上

编辑 `.minecraft/CustomSkinLoader/CustomSkinLoader.json`，把站点放在 `loadlist` 最前面：

```json
{
  "enable": true,
  "loadlist": [
    { "name": "NextSkin", "type": "CustomSkinAPI", "root": "https://nextskin.org/" },
    { "name": "Mojang", "type": "MojangAPI" }
  ]
}
```

`root` 末尾要留斜杠。

### 旧版 CustomSkinLoader（12.9 及以下）

在 `.minecraft/CustomSkinLoader/skinurls.txt` 第一行写：

```
https://nextskin.org/skin/*.png
```

在 `capeurls.txt` 里加：

```
https://nextskin.org/cape/*.png
```

站点保留了这两条旧路径，老 Mod 也能直接取图。

### UniSkinMod

在 `.minecraft/config/UniSkinMod/UniSkinMod.json` 的 `rootURIs` 里加 `https://nextskin.org/usm`。

## 不显示皮肤时

1. 打开 `https://nextskin.org/<角色名>.json`，应该得到类似：

   ```json
   { "username": "Steve", "skins": { "default": "<hash>" }, "cape": null }
   ```

   `/csl/<角色名>.json` 也可以。

2. 用返回的 hash 打开 `https://nextskin.org/textures/<hash>`，能看到图片说明站点这边没问题。
3. 剩下的是客户端：看 `.minecraft/CustomSkinLoader/CustomSkinLoader.log` 里的 `ERROR`，确认 Mod 已加载、`loadlist` 顺序和 `root` 都对。
4. 角色名要和站点上的完全一致。角色名是 Minecraft 的玩家名，不是登录用的邮箱。

更多站点侧的问题见[常见问题](/guide/faq/)。
