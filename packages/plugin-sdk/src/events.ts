import type {
  Actor,
  ExtraFields,
  IsoDateTime,
  Pid,
  Player,
  PublicUser,
  Texture,
  TextureType,
  Tid,
  Uid,
  UserRole,
} from './dto'

/**
 * 事件：事实已经发生、事务已经提交之后才投递。
 *
 * - 经 outbox 表投递，**至少一次**：处理函数必须幂等，用 `event.id` 去重。
 * - 处理函数抛错会按退避重试；超过次数进入死信，在后台可见。
 * - 同一个处理函数收到事件的顺序没有保证，重试会打乱先后。需要最新状态时自己去读，不要依赖事件的顺序。
 * - 事件不能改变结果。想阻止或修改一个操作，用拦截器（interceptors.ts）。
 * - 新增事件是次版本变更；修改或删除已有事件的字段是大版本变更。
 */
export interface CoreEvents {
  'user.registered': { user: PublicUser; extra: ExtraFields }
  'user.loggedIn': { uid: Uid; method: 'password' | 'oauth' | 'passkey' }
  'user.profileUpdated': {
    uid: Uid
    fields: readonly ('nickname' | 'email' | 'password' | 'avatar' | 'locale')[]
  }
  'user.roleChanged': { uid: Uid; from: UserRole; to: UserRole }
  'user.deleted': { uid: Uid }

  'player.created': { player: Player }
  'player.renamed': { player: Player; previousName: string }
  'player.texturesChanged': { player: Player; previous: { skin: Tid | null; cape: Tid | null } }
  'player.deleted': { pid: Pid; uid: Uid; name: string; uuid: string }

  'texture.uploaded': { texture: Texture }
  'texture.updated': { texture: Texture; fields: readonly ('name' | 'type' | 'public' | 'description')[] }
  /** 此 hash 已无条目引用，`/textures/{hash}` 立即 404；文件随后后台删除。投递时文件多半还在，回收前可能重新上传。 */
  'texture.deleted': { tid: Tid; hash: string; type: TextureType; fileDeleted: boolean }

  'closet.itemAdded': { uid: Uid; tid: Tid }
  'closet.itemRemoved': { uid: Uid; tid: Tid }

  'report.created': { reportId: number; tid: Tid; reporter: Uid }
  'report.resolved': {
    reportId: number
    tid: Tid
    action: 'dismissed' | 'textureDeleted' | 'uploaderBanned'
  }

  /** 玩家通过 Yggdrasil 进入了一台正版验证模式的服务器。 */
  'yggdrasil.serverJoined': { pid: Pid; uuid: string; serverId: string }
}

export type EventName = keyof CoreEvents

export interface EventEnvelope<E extends EventName> {
  /** 全局唯一；至少一次投递下用它做幂等。 */
  readonly id: string
  readonly name: E
  readonly occurredAt: IsoDateTime
  readonly actor: Actor
  readonly data: Readonly<CoreEvents[E]>
}

export type EventHandler<E extends EventName, Ctx> = (args: {
  readonly event: EventEnvelope<E>
  readonly ctx: Ctx
}) => Promise<void>
