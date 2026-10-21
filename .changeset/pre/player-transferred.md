---
'@nextskin/plugin-sdk': minor
'@nextskin/plugin-cli': minor
---

新增事件 `player.transferred`（ADR-0036）：管理员在后台把角色转让给另一个用户后发出，带转让之后的 `player: Player`（`uid` 是新主人，pid、UUID、名字不变）和原主人的 `previousUid: Uid`；清掉新主人看不到的材质时先发 `player.texturesChanged`。`player.texturesChanged` 的说明补上转让和下架引起的清空；文档里 `user.roleChanged` 的“角色”改称“身份”，并说明 actor 是发起操作的人，后台操作和连带效果中 `data` 里的用户可能不是 actor，也可能波及管理员自己，只看信封分不出后台操作和连带效果。
