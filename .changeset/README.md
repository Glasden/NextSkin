# Changesets

只有对外发布的包（目前是 `@nextskin/plugin-sdk`）走 changesets；核心应用的包都是 `private`，不在这里管理版本（ADR-0014）。

插件 SDK 的公开 API 有任何变化，都要运行 `pnpm changeset` 写一条变更记录（不变量 9）。
