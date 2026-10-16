'use client'
import { createContext } from 'react'

/** 宿主为每个插槽里的每个插件提供一份。插件通过 usePlugin() 读取。 */
export interface PluginRuntime {
  readonly id: string
  readonly version: string
  readonly slot: string
  /** 请求本插件的路由：path 相对于 /plugins/{id} */
  fetch(path: `/${string}`, init?: RequestInit): Promise<Response>
  /** 站内跳转，走宿主路由（软导航） */
  navigate(href: string): void
}

/** 只给宿主用，不进 shim：插件只需要读上下文（usePlugin），提供上下文不是插件 API 的一部分。 */
export const PluginRuntimeContext = createContext<PluginRuntime | null>(null)
