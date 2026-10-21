---
title: 服主指南
description: 部署与运维 NextSkin。
sidebar:
  order: 1
---

NextSkin 是自托管的站点：一台有 Node.js 的服务器即可运行，默认使用 SQLite，不需要额外的数据库服务。

## 部署

一台有 Node.js 的服务器、一个可写的数据目录就够了。安装步骤（发行包、Docker）、反向代理和环境变量见[安装部署](/guide/install/)。

面板和 systemd 的图文步骤暂时还在[主仓 docs/deploy](https://github.com/Glasden/NextSkin/tree/main/docs/deploy)：宝塔、1Panel、systemd、Windows，以及完整的升级与回退说明。

## 部署之后

首次访问 `/setup` 建站，安装码在数据目录的 `setup-code`。日常运维用启动器的命令行：

```bash
node nextskin.mjs doctor
node nextskin.mjs set-role owner@example.com superadmin
```

`doctor` 只读地检查运行环境；`set-role` 用来指定超级管理员（后台自己动不了这个身份）。全部命令、参数和退出码见[命令行参考](/guide/commands/)。

起不来、登录不上、皮肤不显示这类问题，先看[常见问题](/guide/faq/)。
