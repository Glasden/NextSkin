---
'@nextskin/plugin-sdk': minor
'@nextskin/plugin-cli': minor
---

新增声明式配色主题 `ui.themes` 和类型 `ThemeColor`、`ThemeColorValue`、`ThemeContribution`：插件只写要改的颜色，不需要能力；主题名和色值在构建、安装和加载时校验，manifest 中的色值统一转小写。构建命令检查完整配色的对比度、明暗方向以及强调色和危险色的 OKLab 距离，不通过时逐条列出原因并拒绝构建（ADR-0057）。
