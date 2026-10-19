# @nextskin/plugin-sdk

NextSkin 的插件 API。NextSkin 是用 TypeScript 重写的 Blessing Skin Server（BS）：Minecraft 皮肤站和外置登录（Yggdrasil）。

插件用 `definePlugin` 把自己会做的事全部声明出来：申请哪些能力、订阅哪些事件、拦截什么、提供哪些路由和页面。构建命令把声明提取成 manifest，站长安装之前就能看到插件会做什么；没申请的能力在类型上就不存在，站点运行时也会拒绝。

## 安装

```sh
npm install --save-exact @nextskin/plugin-sdk@rc
npm install --save-dev --save-exact @nextskin/plugin-cli@rc
npm install --save-dev @types/node
```

- 1.0.0 发布之前只有候选版（npm 的 `rc` 标签），发布之后去掉 `@rc`。
- `@nextskin/plugin-cli` 提供构建命令 `nextskin-plugin build`。两个包要装同一个版本。
- 插件项目是 ESM（package.json 里写 `"type": "module"`），需要 Node 24 或更新的版本。

## 最小的插件

`package.json`：

```json
{
  "name": "nextskin-plugin-hello",
  "version": "1.0.0",
  "type": "module",
  "nextskin": { "id": "hello" },
  "scripts": { "build": "nextskin-plugin build" }
}
```

`src/index.ts`：

<!-- docs-example: readme.ts -->

```ts
import { definePlugin } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  on: {
    'user.registered': async ({ event, ctx }) => {
      ctx.log.info('新用户注册', { uid: event.data.user.uid })
    },
  },
})
```

`npm run build` 生成 `dist/hello-1.0.0.tgz`，在站点后台的"插件"页上传、安装、启用。

## 文档

文档随包发布，在 `node_modules/@nextskin/plugin-sdk/docs/` 里：

| 篇目 | 内容 |
|---|---|
| [入门](docs/getting-started.md) | 建项目、写定义、构建、在本地的站点上测试 |
| [能力和上下文](docs/context.md) | `capabilities`、`ctx` 上的各项、出站请求、日志 |
| [事件](docs/events.md) | 17 个事件、至少一次投递、幂等 |
| [拦截器](docs/interceptors.md) | `user.register`、事务内的上下文 |
| [Provider](docs/providers.md) | `passwordHasher`、`login` |
| [路由](docs/routes.md) | `/plugins/{id}/` 下的 HTTP 路由 |
| [界面](docs/ui.md) | 导航、页面、注册表单字段 |
| [设置](docs/settings.md) | 用 zod 写设置项、机密项 |
| [任务和定时任务](docs/jobs.md) | 后台任务、重试和死信、cron |
| [插件表](docs/tables.md) | 自有表、迁移、支持的查询、四种数据库的坑 |
| [安全须知](docs/security.md) | 插件在站点上的权限、机密 |
| [从 BS 迁移](docs/migrating-from-bs.md) | 旧 Hook、Event、Filter 对应的新写法 |
| [版本和兼容](docs/versioning.md) | 插件 API 的版本、两个包怎么升级 |

API 参考就是类型声明里的注释，编辑器里悬停就能看到。

## 许可证

MIT
