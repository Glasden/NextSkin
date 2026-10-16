'use client'
import { Component, Suspense, lazy, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { PluginRuntimeContext, type PluginRuntime } from '@nextskin/plugin-client/internal'
import { Button, Card } from '@nextskin/ui'
import './shared'
import { PluginLoadError, PluginReloadRequired, loadPluginComponent, timeoutMessage } from './loader'
import type { SlotEntry, SlotName } from './types'

type PluginComponent = ComponentType<Record<string, unknown>>

const moduleKey = (entry: SlotEntry) => `${entry.url}#${entry.exportName}`

// lazy 组件必须跨渲染复用，否则每次渲染都会重新挂起
const lazyByModule = new Map<string, PluginComponent>()

function lazyFor(entry: SlotEntry): PluginComponent {
  const key = moduleKey(entry)
  let component = lazyByModule.get(key)
  if (component === undefined) {
    component = lazy(async () => ({ default: await loadPluginComponent(entry) }))
    lazyByModule.set(key, component)
  }
  return component
}

const subscribeNever = () => () => {}

/** 服务端渲染和水合期间为 false：插件代码只在浏览器里、水合之后加载，服务端永远不执行插件代码。 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  )
}

export function PluginSlot({ name, entries }: { readonly name: SlotName; readonly entries: readonly SlotEntry[] }) {
  const hydrated = useHydrated()
  const router = useRouter()
  return (
    <div data-slot={name} className="grid gap-4">
      {entries.map((entry) => (
        <div key={entry.pluginId} data-plugin={entry.pluginId} data-plugin-version={entry.version}>
          {/* 按模块（URL + 导出名）做 key：换版本或改导出名时整层重新挂载，错误状态随之清空，新边界先显示骨架、受骨架计时约束 */}
          <PluginBoundary key={moduleKey(entry)} entry={entry}>
            <Suspense fallback={<SlotSkeleton entry={entry} watchdog />}>
              {hydrated ? <PluginMount slot={name} entry={entry} navigate={router.push} /> : <SlotSkeleton entry={entry} watchdog={false} />}
            </Suspense>
          </PluginBoundary>
        </div>
      ))}
    </div>
  )
}

function PluginMount({ slot, entry, navigate }: { readonly slot: SlotName; readonly entry: SlotEntry; readonly navigate: (href: string) => void }) {
  const runtime = useMemo<PluginRuntime>(
    () => ({
      id: entry.pluginId,
      version: entry.version,
      slot,
      fetch: (path, init) => fetch(`/plugins/${entry.pluginId}${path}`, init),
      navigate,
    }),
    [entry.pluginId, entry.version, slot, navigate],
  )
  const Plugin = lazyFor(entry)
  return (
    <PluginRuntimeContext value={runtime}>
      <Plugin {...entry.props} />
    </PluginRuntimeContext>
  )
}

/**
 * 骨架。作为 Suspense 的 fallback 时带计时：显示超过 timeoutMs 就抛错，交给外层的 PluginBoundary。
 * 这样不只是模块加载，插件组件自己挂起（例如 use() 一个永不完成的 Promise）也有期限。
 */
function SlotSkeleton({ entry, watchdog }: { readonly entry: SlotEntry; readonly watchdog: boolean }) {
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    if (!watchdog) return
    const timer = setTimeout(() => setExpired(true), entry.timeoutMs)
    return () => clearTimeout(timer)
  }, [watchdog, entry.timeoutMs])
  if (expired) throw new PluginLoadError(timeoutMessage(entry))
  return (
    <Card data-slot-state="loading" aria-busy="true" title={entry.pluginId}>
      <p className="text-sm text-text-muted">加载中…</p>
    </Card>
  )
}

/** 每个插件一层：渲染、effect、生命周期里抛出的错误，模块和样式表加载失败，加载或显示超时，都停在这里。 */
class PluginBoundary extends Component<{ readonly entry: SlotEntry; readonly children: ReactNode }, { readonly error: Error | null }> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    if (error instanceof PluginReloadRequired) return
    // 正式实现：上报给核心，计入该插件的熔断计数（ADR-0009）
    console.error(`[plugin:${this.props.entry.pluginId}]`, error, info.componentStack)
  }

  override render() {
    const { error } = this.state
    if (error === null) return this.props.children
    if (error instanceof PluginReloadRequired) {
      return (
        <Card data-slot-state="reload" title={this.props.entry.pluginId}>
          <p className="mb-2 text-sm text-text">这个插件已更新，刷新页面后生效。</p>
          <Button onClick={() => window.location.reload()}>刷新页面</Button>
        </Card>
      )
    }
    return (
      <Card tone="danger" data-slot-state="error" data-error-name={error.name} data-error={error.message} title={this.props.entry.pluginId}>
        <p className="text-sm text-text">这个插件出错了，页面的其他部分不受影响。</p>
      </Card>
    )
  }
}
