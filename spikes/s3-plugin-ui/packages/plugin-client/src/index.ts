'use client'
import { use } from 'react'
import { PluginRuntimeContext, type PluginRuntime } from './internal'

export type { PluginRuntime }

export function usePlugin(): PluginRuntime {
  const runtime = use(PluginRuntimeContext)
  if (runtime === null) throw new Error('usePlugin() 只能在插件插槽内调用')
  return runtime
}
