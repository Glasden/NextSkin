import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { cookies } from 'next/headers'
import type { Json, SlotEntry, SlotName, SriMode } from './types'

/** scripts/build-plugins.ts 生成 */
interface Installed {
  readonly plugins: Readonly<
    Record<
      string,
      {
        readonly defaultVersion: string
        readonly versions: Readonly<
          Record<string, { readonly client: Asset; readonly css: Asset | null }>
        >
      }
    >
  >
  readonly widgets: readonly { readonly plugin: string; readonly slot: SlotName; readonly export: string }[]
}

interface Asset {
  readonly url: string
  readonly integrity: string
}

const dataDir = path.join(process.cwd(), 'data')
/** spike 里统一用 8 秒；dev 模式第一次请求要现编译 /plugins-assets 路由 */
const LOAD_TIMEOUT_MS = 8000

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

/** 每次请求都重新读：测试会改 active.json 来模拟 plugin host 换代后启用新版本 */
async function readRegistry() {
  const installed = await readJson<Installed>(path.join(dataDir, 'plugins/installed.json'), { plugins: {}, widgets: [] })
  const active = await readJson<Record<string, string>>(path.join(dataDir, 'plugins/active.json'), {})
  return { installed, active }
}

export async function sriMode(): Promise<SriMode> {
  return (await cookies()).get('s3-sri')?.value === 'none' ? 'none' : 'map'
}

export async function slotEntries(slot: SlotName, sri: SriMode, props: { readonly [key: string]: Json } = {}): Promise<SlotEntry[]> {
  const { installed, active } = await readRegistry()
  const entries: SlotEntry[] = []
  for (const widget of installed.widgets) {
    if (widget.slot !== slot) continue
    const plugin = installed.plugins[widget.plugin]
    if (plugin === undefined) continue
    const version = active[widget.plugin] ?? plugin.defaultVersion
    const files = plugin.versions[version]
    if (files === undefined) continue
    entries.push({
      pluginId: widget.plugin,
      version,
      url: files.client.url,
      exportName: widget.export,
      requireIntegrity: sri === 'map',
      css: files.css === null ? null : { url: files.css.url, integrity: sri === 'none' ? null : files.css.integrity },
      props,
      timeoutMs: LOAD_TIMEOUT_MS,
    })
  }
  return entries
}

/** 写进 import map 的 integrity：当前启用的全部插件入口（不只是本页用到的，软导航到别的页面时也覆盖） */
export async function activeModuleIntegrity(): Promise<Record<string, string>> {
  const { installed, active } = await readRegistry()
  const result: Record<string, string> = {}
  for (const [id, plugin] of Object.entries(installed.plugins)) {
    const files = plugin.versions[active[id] ?? plugin.defaultVersion]
    if (files !== undefined) result[files.client.url] = files.client.integrity
  }
  return result
}
