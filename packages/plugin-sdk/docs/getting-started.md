# 入门

这一篇带你从空目录写出一个能构建、安装的插件。其余扩展点从[能力和上下文](./context.md)开始读。

## 建项目

需要 Node 24 或更新版本。插件项目是 ESM，`package.json` 必须写 `"type": "module"`。SDK 提供类型和辅助函数，CLI 提供构建命令；两个包装同一个版本，包括 `-rc.N` 后缀。

```sh
npm init -y
npm pkg set type=module
npm install --save-exact @nextskin/plugin-sdk@rc
npm install --save-dev --save-exact @nextskin/plugin-cli@rc
npm install --save-dev @types/node
```

候选期使用 `rc` 标签；1.0.0 发布之后去掉 `@rc`。已有项目升级时把两个包一起换到同一个具体版本；[版本和兼容](./versioning.md)解释如何兼容旧核心。

保留安装命令生成的依赖项，把项目的其余字段设成：

```json
{
  "name": "nextskin-plugin-hello",
  "version": "1.0.0",
  "type": "module",
  "nextskin": { "id": "hello" },
  "scripts": { "build": "nextskin-plugin build" }
}
```

`name` 是 npm 项目名，`nextskin.id` 才是站点识别插件的名字。id 匹配 `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`，最多 64 字符，安装后不要改名。`version` 是插件自己的 semver 版本，不是 SDK 版本。不要占用官方插件的 id。

依赖别的插件时，在 `nextskin` 里写 `"requires": { "other-plugin": "^1.0.0" }`；不能同时启用时写 `"conflicts": ["incompatible-plugin"]`。依赖的插件必须启用且版本满足范围。反向依赖也会检查：被其他启用插件依赖时不能随意停用、卸载或升级到不满足范围的版本。完整语法见[版本和兼容](./versioning.md)。

## 写入口和文案

创建 `src/index.ts`，默认导出 `definePlugin` 的返回值。下面是完整入口：

<!-- docs-example: getting-started.ts -->

```ts
import { definePlugin } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  on: {
    'user.registered': async ({ event, ctx }) => {
      ctx.log.info(ctx.t('log.registered'), { uid: event.data.user.uid })
    },
  },
})
```

创建 `locales/zh-CN.json`：

```json
{
  "plugin": {
    "name": "注册记录",
    "description": "把新注册用户的编号写进站点日志。"
  },
  "log": { "registered": "新用户注册" }
}
```

再创建 `locales/en.json`：

```json
{
  "plugin": {
    "name": "Registration log",
    "description": "Write new user IDs to the site log."
  },
  "log": { "registered": "User registered" }
}
```

文案是嵌套 JSON 对象，键用点分隔，支持 ICU MessageFormat。先找请求语言，再找站点默认语言；都找不到就显示键名。后台名称取 `plugin.name`，缺少时显示 id；简介取 `plugin.description`。

这个插件不需要能力：事件已经带了公开用户资料。事件至少投递一次，所以日志可能重复；有外部副作用的处理函数要按[事件](./events.md)一篇做幂等。

## 构建

```sh
npm run build
npx nextskin-plugin build . --out dist/hello.tgz
```

命令格式是 `nextskin-plugin build [目录] [--out 文件]`。目录默认是当前目录；默认产物是插件目录下的 `dist/<id>-<version>.tgz`。显式 `--out` 相对于运行命令的当前目录解析。

入口固定是 `src/index.ts`。构建器打成单文件 `server.mjs`，执行入口模块来提取 manifest，打包 `locales/` 下的 JSON，再校验整个包。**入口及其依赖的顶层代码会在构建时执行**，不要在那里联网、读生产机密或启动计时器；业务逻辑放在处理函数中。构建不会调用事件、路由、任务等 handler，也不会替你做 TypeScript 类型检查。

SDK 和 zod 在运行时由 host 提供；其他依赖应能打进服务端单文件。安装插件时不会运行 `npm install`，不要依赖本机的文件、原生扩展或未打包的模块。

## 类型检查

构建不检查类型，要自己跑 TypeScript。装上它，在项目根目录放一个 `tsconfig.json`：

```sh
npm install --save-dev typescript
```

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

构建之前跑一遍 `npx tsc`。SDK 发布前在 TypeScript 6 和 7、`bundler` 和 `nodenext` 两种模块解析下都检查过，用 `nodenext` 时把 `module` 也改成 `nodenext`。

## 在本地站点测试

目前核心还没有发行包，测试站需要单独克隆 NextSkin 仓库、安装依赖，在那个仓库运行 `pnpm dev`。默认使用 SQLite，不需要外部数据库。空站先访问 `/setup` 建站，安装码在 `apps/web/data/setup-code`；安装前不能注册。

用超级管理员打开 `/admin/plugins`，上传 tgz（最多 10 MiB），核对能力、出站 origin、路由和表，确认安装。安装完成还没启用；进入详情页启用，核心先跑迁移，再切换 host。需要设置的插件在详情页填写设置。

注册一个测试用户，在运行 `pnpm dev` 的终端里查找 `[plugin:hello]`。核心还会记录 `[plugins] hello on:user.registered …ms ok` 这类调用结果。后台详情页能看到最近错误和死信，能重试或删除死信；普通日志看服务端输出。

更新代码后增加插件自己的 version，再重新构建、上传升级；新版本必须大于已安装版本，同版替换也会被拒绝。迁移只向前走，不支持降级。停用保留设置、数据和积压任务；卸载会删除这些数据，不能当成临时开关。
