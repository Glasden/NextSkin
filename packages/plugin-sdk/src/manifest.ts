import type { Capability } from './capabilities'
import type { EventName } from './events'
import type { Json } from './dto'
import type { InterceptorName } from './interceptors'
import type { HttpMethod } from './routes'
import type { IconName, MessageKey, UiContributions } from './ui'

/**
 * `nextskin-plugin build` 产出的 manifest.json。
 *
 * 它由构建工具从插件定义里提取，不手写。核心和插件市场只读这个文件就能知道插件会做什么，
 * 不需要执行插件代码：安装前展示权限、检测冲突、生成设置页都靠它。
 * 核心按它登记路由、事件、拦截器、Provider、任务和定时任务；插件实际的定义和它对不上，就不加载。
 *
 * id、requires、conflicts 来自插件 package.json 的 `nextskin` 字段；
 * version 来自 package.json；api 由构建时使用的 SDK 版本推出。
 */
export interface PluginManifest {
  readonly manifestVersion: 1
  readonly id: string
  readonly version: string
  /** 兼容的插件 API 版本范围，例如 '^1.0.0' */
  readonly api: string
  readonly requires: Readonly<Record<string, string>>
  readonly conflicts: readonly string[]

  readonly capabilities: readonly Capability[]
  readonly network: readonly string[]
  /** settings schema 转成的 JSON Schema（输入类型）；机密项标 `writeOnly`。没有设置项时为 null */
  readonly settingsSchema: Readonly<Record<string, Json>> | null
  readonly permissions: Readonly<Record<string, MessageKey>>
  readonly tables: readonly string[]
  readonly migrations: readonly string[]

  readonly events: readonly EventName[]
  readonly interceptors: readonly {
    readonly name: InterceptorName
    readonly priority: number
  }[]
  readonly providers: {
    readonly passwordHasher: readonly {
      readonly id: string
      readonly label: MessageKey
      /** 核心在本进程内按它匹配，匹配上了才调用插件 */
      readonly detect: { readonly prefix?: readonly string[]; readonly pattern?: string }
    }[]
    readonly login: readonly { readonly id: string; readonly label: MessageKey; readonly icon: IconName }[]
  }
  readonly routes: readonly {
    readonly method: HttpMethod
    readonly path: string
    readonly auth: 'public' | 'user'
    readonly permission: string | null
    readonly maxBodyBytes: number
    readonly rateLimit: { readonly limit: number; readonly windowSec: number; readonly by: 'ip' | 'user' } | null
  }[]
  readonly jobs: readonly { readonly name: string; readonly maxAttempts: number; readonly timeoutMs: number }[]
  readonly cron: readonly { readonly schedule: string; readonly job: string; readonly payload: Json }[]
  readonly ui: UiContributions<Record<string, MessageKey>>

  readonly entry: {
    /** 服务端单文件 ESM；纯声明式插件可以没有 */
    readonly server: string | null
  }
  /** 包内每个文件的 sha256，安装时校验 */
  readonly integrity: Readonly<Record<string, string>>
}

/**
 * 插件 package.json 中的 `nextskin` 字段。
 * 依赖语义沿用旧版：requires 写其他插件 id 与 semver 范围。
 */
export interface PluginPackageField {
  readonly id: string
  readonly requires?: Readonly<Record<string, string>>
  readonly conflicts?: readonly string[]
}
