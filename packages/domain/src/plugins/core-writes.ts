/** 插件写核心数据的参数边界；业务规则仍由领域用例检查（ADR-0041）。 */
import { hasPluginMessage, type PluginMessages } from '@nextskin/plugin-host'
import { isStorageKey } from '../text.ts'
import { PluginCallRejected } from './errors.ts'

export function scoreAdjustInput(args: Record<string, unknown>, messages: PluginMessages) {
  const { uid, delta, reason, key } = args
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 1)
    throw new PluginCallRejected('uid 必须是正安全整数')
  if (typeof delta !== 'number' || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 2147483647)
    throw new PluginCallRejected('delta 必须是绝对值不超过 2147483647 的非零安全整数')
  if (
    typeof reason !== 'string' ||
    [...reason].length < 1 ||
    [...reason].length > 128 ||
    !hasPluginMessage(messages, reason)
  )
    throw new PluginCallRejected('reason 必须是本插件文案里存在的键，长度在 1 到 128 个字符之间')
  if (typeof key !== 'string' || !isStorageKey(key, 255))
    throw new PluginCallRejected('key 必须是 1 到 255 个字符的字符串，没有首尾空白、NUL 或不成对的代理项')
  return { uid, delta, reason, key }
}

export function notificationSendInput(args: Record<string, unknown>, messages: PluginMessages) {
  const { uid, notification, key } = args
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 1)
    throw new PluginCallRejected('uid 必须是正安全整数')
  if (!plainObject(notification)) throw new PluginCallRejected('notification 必须是普通对象')
  const messageKey = (value: unknown, field: string): string => {
    if (
      typeof value !== 'string' ||
      [...value].length < 1 ||
      [...value].length > 128 ||
      value.includes('\0') ||
      !value.isWellFormed() ||
      !hasPluginMessage(messages, value)
    )
      throw new PluginCallRejected(
        `${field} 必须是本插件文案里存在的键，长度在 1 到 128 个码位之间，不能含 NUL 或不成对的代理项`,
      )
    return value
  }
  const title = messageKey(notification.title, 'title')
  const body = notification.body === undefined ? undefined : messageKey(notification.body, 'body')
  let params: Record<string, string | number> | undefined
  if (notification.params !== undefined) {
    if (!plainObject(notification.params) || Object.keys(notification.params).length > 20)
      throw new PluginCallRejected('params 必须是最多 20 项的普通对象')
    const entries = Object.entries(notification.params)
    for (const [name, value] of entries) {
      if ([...name].length < 1 || [...name].length > 64 || name.includes('\0') || !name.isWellFormed())
        throw new PluginCallRejected('params 的键必须是 1 到 64 个码位，不能含 NUL 或不成对的代理项')
      if (
        !(typeof value === 'string'
          ? [...value].length <= 200 && !value.includes('\0') && value.isWellFormed()
          : typeof value === 'number' && Number.isFinite(value))
      )
        throw new PluginCallRejected(
          'params 的值必须是有限数字或不超过 200 个码位的字符串，不能含 NUL 或不成对的代理项',
        )
    }
    params = Object.fromEntries(entries) as Record<string, string | number>
  }
  const link = notification.link
  if (
    link !== undefined &&
    (typeof link !== 'string' ||
      !link.startsWith('/') ||
      link.startsWith('//') ||
      link.includes('\\') ||
      !link.isWellFormed() ||
      [...link].some((character) => character < ' ' || character === '\u007f') ||
      link.length > 500)
  )
    throw new PluginCallRejected(
      'link 必须是以单个 / 开头、不超过 500 个字符的站内路径，不能含反斜杠、控制字符或不成对的代理项',
    )
  if (typeof key !== 'string' || !isStorageKey(key, 255))
    throw new PluginCallRejected('key 必须是 1 到 255 个字符的字符串，没有首尾空白、NUL 或不成对的代理项')
  return { uid, title, body, params, link, key }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}
