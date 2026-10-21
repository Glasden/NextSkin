import { join, resolve } from 'node:path'
import { pluginHostEntry } from '@nextskin/domain'
import type { LauncherContext } from './context.ts'

/** plugin host 的入口：发行目录里是 server/ 下打好包的 host.mjs，源码里运行 plugin-host 的源码 */
export function launcherPluginHost(context: LauncherContext) {
  return pluginHostEntry({
    root: context.source ? resolve(context.root, '../..') : join(context.root, 'server'),
    bundled: !context.source,
  })
}
