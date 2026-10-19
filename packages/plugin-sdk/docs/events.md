# 事件

事件表示已经发生的事实。需要在注册、角色换材质、删除材质等操作后同步外部系统时，用 `on` 订阅；要阻止注册，读[拦截器](./interceptors.md)。

## 投递和失败

事件在业务事务中按当时的订阅者展开为持久任务，事务提交后才执行处理函数；回滚则事件任务也消失。后来才启用的插件收不到过去的事件。插件停用后不再收新事件，原有任务保留，重新启用后继续执行。

每次 handler 期限 60 秒，准备上下文也计时。至少一次投递，顺序不保证；进程退出、超时或重试都可能重复。外部写入使用 `event.id` 作为幂等键；读取最新状态时再调用 ctx API，不能假定事件携带的是当前状态。

抛错或超时默认最多尝试 5 次。失败后按 10 秒起的指数退避，基础值最多 1 小时，再乘 0.8–1.2 的随机抖动。用尽次数进入后台插件详情页的死信，可重试或删除；重试从 0 次重新开始。host 不可用时积压留在队列，不算失败尝试。不要吞掉需要重试的错误，也不要把机密放进异常消息：消息会进入错误记录。任务机制详见[任务](./jobs.md)。

## 信封和 17 个事件

每个 handler 收到 `{ event, ctx }`。`event` 有 `id`（全局唯一）、`name`、`occurredAt`（UTC ISO 字符串）、`actor` 和 `data`。下表完整列出 data 字段；DTO 的具体字段见 SDK 类型声明和[上下文](./context.md)。

actor 是发起这次操作的人。后台操作和连带效果（材质改私有或删除后，清理别人的衣柜、角色、头像）里，`data` 里的用户可能不是 actor；后台操作也可能波及管理员自己。只看信封分不出后台操作和连带效果。

**下列 17 个事件的订阅都不需要能力**，也不会因为未申请读取能力而去掉 data。仅在 handler 额外调用 ctx API 时才按能力检查。

| 事件 | 何时发出 | data |
|---|---|---|
| `user.registered` | 注册用例建用户成功，包括第三方首次完成注册；安装向导建首个超级管理员也发出（通常尚无插件订阅） | `user: PublicUser`、`extra: ExtraFields`（只含本插件的注册字段） |
| `user.profileUpdated` | 用户资料更新 | `uid`、`fields`：`nickname`、`email`、`password`、`avatar`、`locale` 或以后新增值 |
| `user.roleChanged` | 封禁或变更用户的身份 | `uid`、`from: UserRole`、`to: UserRole` |
| `user.deleted` | 删除用户 | `uid` |
| `player.created` | 创建 Minecraft 角色 | `player: Player` |
| `player.renamed` | 角色改名 | `player: Player`（改后）、`previousName` |
| `player.texturesChanged` | 角色的皮肤或披风槽改变，包括材质删除引起的清空、后台转让时清掉新主人看不到的材质、材质被下架（管理员下架公开材质时连带清掉角色上的材质） | `player: Player`（改后）、`previous: { skin: Tid \| null, cape: Tid \| null }` |
| `player.transferred` | 管理员在后台把角色转让给另一个用户 | `player: Player`（转让之后，`uid` 是新主人）、`previousUid` |
| `player.deleted` | 删除角色，包括删除用户时其名下角色 | `pid`、`uid`、`name`、`uuid` |
| `texture.uploaded` | 上传材质条目 | `texture: Texture` |
| `texture.updated` | 更新材质信息 | `texture: Texture`（改后）、`fields`：`name`、`type`、`public`、`description` 或以后新增值 |
| `texture.deleted` | 删除材质条目 | `tid`、`hash`、`type: TextureType`、`lastReference: boolean` |
| `closet.itemAdded` | 材质加入衣柜 | `uid`、`tid` |
| `closet.itemRemoved` | 从衣柜移除材质 | `uid`、`tid` |
| `report.created` | 提交举报 | `reportId`、`tid`、`reporter: Uid` |
| `report.resolved` | 举报结案，包括材质删除导致的结案 | `reportId`、`tid`、`action`：`dismissed`、`textureDeleted`、`uploaderBanned` 或以后新增值 |
| `yggdrasil.serverJoined` | Yggdrasil 确认玩家进入正版验证模式的服务器 | `pid`、`uuid`、`serverId` |

`texture.deleted.lastReference` 为 false 表示还有其他条目引用相同 hash，`/textures/{hash}` 继续可用；为 true 时公开地址立即 404，文件随后由后台回收。不能把每次条目删除都当成文件删除。

## 示例和开放的值

```ts
import { definePlugin } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  on: {
    'report.resolved': async ({ event, ctx }) => {
      switch (event.data.action) {
        case 'dismissed':
          ctx.log.info('举报未采纳', { reportId: event.data.reportId })
          break
        case 'textureDeleted':
        case 'uploaderBanned':
          ctx.log.info('举报已处理', { reportId: event.data.reportId })
          break
        default:
          // 次版本可能增加动作，未知值也必须能正常处理。
          ctx.log.info('其他结案动作', { action: event.data.action })
      }
    },
  },
})
```

两个更新事件的 `fields`、举报的 `action`、`UserRole`、`TextureType` 都允许以后增加字符串。不要用 `never` 穷尽它们，switch 要有默认分支；数组筛选也要忽略不认识的成员。`Actor` 是封闭的对象联合，规则不同，见[版本和兼容](./versioning.md)。

外部刷新和重试的完整例子见 [cdn-refresh](https://github.com/Glasden/NextSkin/tree/main/plugins/cdn-refresh)。如果把本地去重标记写在 KV 里再调用外部 API，中途失败会丢副作用；反过来写又可能重复。优先用外部服务自己的幂等键，不能把 KV 的“读到不存在再写入”当成原子去重。
