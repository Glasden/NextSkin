---
'@nextskin/plugin-sdk': minor
'@nextskin/plugin-cli': minor
---

新增能力 `users.score` 和 `ctx.users.adjustScore`（ADR-0041）：插件以永久幂等键给任何用户加减积分，`ScoreAdjustResult` 返回业务状态和余额。注册表单字段新增 `fromQuery`，允许 text、textarea、number、select 从带插件 id 的查询参数预填。
