---
'@nextskin/plugin-sdk': minor
'@nextskin/plugin-cli': minor
---

`users.read`、`users.readPrivate` 新增 `ctx.users.searchByNickname(query, { after?, limit? })`：昵称包含 query 的用户，ASCII 字母不分大小写，按 uid 升序往后翻页，每次最多 100 个；新类型 `UserSearchOptions`（ADR-0050）。
