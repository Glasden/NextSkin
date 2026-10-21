---
'@nextskin/plugin-sdk': patch
'@nextskin/plugin-cli': patch
---

KV 的键和任务的 `dedupeKey` 不再接受 NUL 和不成对的代理项，规则同 `adjustScore` 的 key：PostgreSQL 存不了 NUL；不成对的代理项写进数据库会变成 U+FFFD，两个不同的键会撞成一个。
