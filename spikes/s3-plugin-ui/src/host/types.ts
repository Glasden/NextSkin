export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

/** 和 packages/plugin-sdk/src/ui.ts 的 SlotName 一致 */
export type SlotName =
  | 'user.dashboard'
  | 'admin.dashboard'
  | 'user.profile.sections'
  | 'skinlib.detail.sidebar'
  | 'player.card.footer'

/** 服务端交给 PluginSlot 的一项：只含可序列化的数据 */
export interface SlotEntry {
  readonly pluginId: string
  readonly version: string
  /** 同源 /plugins-assets/{id}/{version}/… */
  readonly url: string
  readonly exportName: string
  /**
   * 为 true 时，只在页面的 import map 为这个 URL 写了 integrity 时才加载。
   * 插件换代后（URL 变了）如果页面没有刷新，import map 里没有新 URL，插槽改为提示刷新，不加载未经校验的代码。
   */
  readonly requireIntegrity: boolean
  readonly css: { readonly url: string; readonly integrity: string | null } | null
  readonly props: { readonly [key: string]: Json }
  readonly timeoutMs: number
}

/**
 * 'map'：integrity 写在 import map 里（推荐，三个引擎都强制校验动态 import 及其依赖）。
 * 'none'：不校验，用来对照。
 * 不用 modulepreload 的 integrity：WebKit 不校验，Firefox 校验失败后 import() 会重新请求并执行（见 probes/）。
 */
export type SriMode = 'map' | 'none'
