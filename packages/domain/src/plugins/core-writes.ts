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
