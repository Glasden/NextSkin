# packages/plugin-host

插件侧的运行时（ADR-0009、ADR-0033）：host 进程的入口和帧协议、加载插件定义、构造 `ctx`、插件包的格式和校验。核心侧的注册表、网关、换代和安装在 `packages/domain/src/plugins/`。

- **私有包，但有一部分随构建命令发布。** `@nextskin/plugin-cli` 发布时把这里提取 manifest、插件包格式、模块钩子的代码打进单文件（ADR-0035）。改了这几处，要给 `@nextskin/plugin-cli` 写 changeset：CI 的 changeset 检查只看发布的包自己的 `src`，看不到这里。
- **插件 API 的版本不写死**：`PLUGIN_API_VERSION` 从 SDK 的 package.json 读，manifest 的 `api` 用 `pluginApiRange()` 算（ADR-0035）。
- **运行时检查不信任类型**：插件可以是手写 JS，manifest 校验和 `ctx` 的每个入口都要在运行时重复 SDK 类型上的约束（见 `packages/plugin-sdk/AGENTS.md`）。
