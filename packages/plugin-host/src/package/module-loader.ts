import { isBuiltin, registerHooks } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 插件包里能 import 的外部模块，映射到本进程里已经加载的实例。 */
export const PLUGIN_EXTERNALS = ['@nextskin/plugin-sdk', 'zod'] as const
export type PluginExternalModules = Record<(typeof PLUGIN_EXTERNALS)[number], object>
const registry = Symbol.for('nextskin.plugin-modules')
const installed = Symbol.for('nextskin.plugin-module-hooks')
const state = globalThis as typeof globalThis & { [registry]?: PluginExternalModules; [installed]?: boolean }
const scheme = 'nextskin-shim:'

/** 进程级只安装一次；内置模块、相对路径和 file: URL 交给 Node，其余裸说明符必须打包。 */
export function installPluginModuleHooks(modules: PluginExternalModules): void {
  if (state[installed]) return
  const sources = new Map<string, string>()
  for (const name of PLUGIN_EXTERNALS) {
    const namespace = modules[name]
    const lines = [`const m = globalThis[Symbol.for('nextskin.plugin-modules')][${JSON.stringify(name)}];`]
    Object.keys(namespace).forEach((key, index) => {
      if (key === 'default') lines.push('export default m.default;')
      else lines.push(`const e${index} = m[${JSON.stringify(key)}]; export { e${index} as ${JSON.stringify(key)} };`)
    })
    sources.set(`${scheme}${name}`, lines.join('\n'))
  }
  state[registry] = modules
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if ((PLUGIN_EXTERNALS as readonly string[]).includes(specifier))
        return { url: `${scheme}${specifier}`, shortCircuit: true }
      if (
        isBuiltin(specifier) ||
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier.startsWith('file:')
      )
        return nextResolve(specifier, context)
      throw new Error(`插件不能导入 ${JSON.stringify(specifier)}：其他依赖要打包进 server.mjs`)
    },
    load(url, context, nextLoad) {
      const source = sources.get(url)
      return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true }
    },
  })
  state[installed] = true
}

/** 从绝对路径加载插件定义；由 Node 缓存，同一路径只执行一次。 */
export async function importPluginDefinition(file: string): Promise<unknown> {
  if (!isAbsolute(file)) throw new Error('插件入口必须是绝对路径')
  const namespace = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  if (!Object.hasOwn(namespace, 'default')) throw new Error('插件入口必须提供 default 导出')
  return namespace.default
}
