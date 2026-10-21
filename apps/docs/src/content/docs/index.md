---
title: NextSkin 文档
description: Minecraft 皮肤托管与外置登录站点 NextSkin 的部署、使用和插件开发文档。
template: splash
hero:
  tagline: 自托管的 Minecraft 皮肤站与外置登录（Yggdrasil）服务
  actions:
    - text: 部署站点
      link: /guide/
    - text: 开发插件
      link: /plugins/
      variant: minimal
---

## 从这里开始

- **服主**：把 NextSkin 部署到自己的服务器，接上游戏服的外置登录。见[服主指南](/guide/)。
- **玩家**：上传皮肤和披风、管理角色。见[玩家指南](/players/)。
- **插件作者**：用 `@nextskin/plugin-sdk` 扩展站点。见[插件开发](/plugins/)。

项目同时运行在 [nextskin.org](https://nextskin.org)，文档里的站点地址示例都用它。

## 这个站点怎么更新

产品文档、ADR 和源码在 [Glasden/NextSkin](https://github.com/Glasden/NextSkin)。插件 API 参考在每次构建时从主仓 `packages/plugin-sdk/docs` 同步，所以页面上标注的版本就是文档对应的 SDK 版本。
