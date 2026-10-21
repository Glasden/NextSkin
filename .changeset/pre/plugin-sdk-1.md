---
'@nextskin/plugin-sdk': major
'@nextskin/plugin-cli': major
---

第一个正式版本（ADR-0033、ADR-0035）。

- `@nextskin/plugin-sdk`：用 `definePlugin` 声明插件会做的全部事情。17 个事件、1 个拦截点（`user.register`）、2 类 Provider（`passwordHasher`、`login`）、8 项能力（7 项只读核心数据或读写插件自己的数据，1 项以永久幂等键改积分）；插件自有表、KV、任务和定时任务、挂在 `/plugins/{id}/` 下的路由；声明式的导航、页面（表格、表单、统计、Markdown）和注册表单字段（可以从注册链接预填）；设置页由 zod schema 生成。
- `@nextskin/plugin-cli`：`nextskin-plugin build` 把插件打成插件包，在站点后台上传安装。

两个包要装同一个版本。文档在 SDK 包的 `docs/` 目录里，从 README 看起。
