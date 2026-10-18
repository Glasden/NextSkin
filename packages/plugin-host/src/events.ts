import type { EventName } from '@nextskin/plugin-sdk'

/** SDK 的事件只有类型；运行时检查插件定义要用名字的列表。漏了或多了一个都是编译错误 */
const names = {
  'user.registered': true,
  'user.profileUpdated': true,
  'user.roleChanged': true,
  'user.deleted': true,
  'player.created': true,
  'player.renamed': true,
  'player.texturesChanged': true,
  'player.deleted': true,
  'texture.uploaded': true,
  'texture.updated': true,
  'texture.deleted': true,
  'closet.itemAdded': true,
  'closet.itemRemoved': true,
  'report.created': true,
  'report.resolved': true,
  'yggdrasil.serverJoined': true,
} as const satisfies Record<EventName, true>

export const eventNames = Object.keys(names) as EventName[]
