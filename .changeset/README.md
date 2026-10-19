# Changesets

只有对外发布的两个包走 changesets：`@nextskin/plugin-sdk` 和 `@nextskin/plugin-cli`。它们在 `config.json` 的 `fixed` 组里，版本号永远相同；核心应用的包都是 `private`，不在这里管理版本（ADR-0014、ADR-0035）。

- 插件 SDK 的公开 API 有任何变化，都要运行 `pnpm changeset` 写一条变更记录（不变量 9）。
- 构建命令打进了 plugin-host 的一部分（提取 manifest、包格式、模块钩子）。plugin-host 是私有包，CI 的检查看不到它；改了这些地方，也要给 `@nextskin/plugin-cli` 写一条。
- 版本号怎么改、怎么发布见 ADR-0035 的"发布流程"：本地 `pnpm changeset version`，提交后推到 main，由 `.github/workflows/release.yml` 发布。
