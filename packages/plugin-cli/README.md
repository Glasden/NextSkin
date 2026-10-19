# @nextskin/plugin-cli

`nextskin-plugin build`：把 NextSkin 插件打成插件包，在站点后台上传安装。插件 API 和文档在 [`@nextskin/plugin-sdk`](https://www.npmjs.com/package/@nextskin/plugin-sdk)。

```sh
npm install --save-dev @nextskin/plugin-cli
npx nextskin-plugin build [目录] [--out 文件]
```

- 目录默认是当前目录，输出默认是 `dist/<插件 id>-<版本>.tgz`。
- 插件项目的约定：package.json 里有 `"type": "module"` 和 `nextskin` 字段（插件 id，可选的 `requires`、`conflicts`），入口是 `src/index.ts`，文案在 `locales/<语言>.json`。
- 和 `@nextskin/plugin-sdk` 装同一个版本。插件项目里的 SDK 比构建命令新、或者大版本不同，构建会报错。
- 构建会执行入口模块的顶层代码，用来读出插件定义；只构建你信任的源码。
- 插件的依赖都打进插件包里的 `server.mjs`；`@nextskin/plugin-sdk` 和 `zod` 除外，它们由站点提供。

## 许可证

MIT
