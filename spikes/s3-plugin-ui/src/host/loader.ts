import type { ComponentType } from 'react'
import type { SlotEntry } from './types'

export class PluginLoadError extends Error {
  override name = 'PluginLoadError'
}

/** 插件已换代，但这个页面的 import map 里没有新版本的 integrity：要刷新页面才能加载 */
export class PluginReloadRequired extends Error {
  override name = 'PluginReloadRequired'
}

const ASSET_PREFIX = '/plugins-assets/'

/**
 * 插件资源一律换成绝对 URL 再使用。相对 URL 在 import() 里按调用方模块的 URL 解析，
 * 在 import map 里按页面 URL 解析，两者不一致时，覆盖检查和实际请求的会是两个文件。
 */
function assetHref(url: string): string {
  const href = new URL(url, document.baseURI)
  if (href.origin !== location.origin || !href.pathname.startsWith(ASSET_PREFIX) || href.search !== '' || href.hash !== '') {
    throw new PluginLoadError(`插件资源只能来自同源的 ${ASSET_PREFIX}：${url}`)
  }
  return href.href
}

let covered: ReadonlySet<string> | undefined

/**
 * 页面 import map 里写了 integrity 的 URL。import map 只在首次加载时由服务端生成，之后不会变
 * （Firefox 不支持第二个 import map，所以不能在运行中追加）。
 */
function integrityCoveredUrls(): ReadonlySet<string> {
  if (covered === undefined) {
    const script = document.querySelector('script[type="importmap"]')
    const map = JSON.parse(script?.textContent ?? '{}') as { integrity?: Record<string, string> }
    covered = new Set(Object.keys(map.integrity ?? {}).map((url) => new URL(url, document.baseURI).href))
  }
  return covered
}

const stylesheets = new Map<string, Promise<void>>()

/**
 * 插件样式表由加载器自己插入并等待，不交给 React 的 <link precedence>：
 * React 会把同一次提交里所有揭示的边界一起挂起等样式表，一个插件的样式表挂起会连带别的插件；
 * 样式表 404 或 integrity 不符时 React 也照样渲染，只是没有样式。这里两种情况都进入该插件的错误边界。
 */
function loadStylesheet(href: string, integrity: string | null): Promise<void> {
  let pending = stylesheets.get(href)
  if (pending === undefined) {
    pending = new Promise<void>((resolve, reject) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      if (integrity !== null) link.integrity = integrity
      link.dataset.pluginStylesheet = ''
      link.addEventListener('load', () => resolve(), { once: true })
      link.addEventListener(
        'error',
        () => {
          link.remove()
          reject(new PluginLoadError(`插件样式表加载失败（网络错误或 integrity 不符）：${href}`))
        },
        { once: true },
      )
      document.head.append(link)
    })
    stylesheets.set(href, pending)
  }
  return pending
}

export function timeoutMessage(entry: SlotEntry): string {
  return `${entry.pluginId}@${entry.version} 加载超时（${entry.timeoutMs} ms）`
}

function withTimeout<T>(task: Promise<T>, entry: SlotEntry): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginLoadError(timeoutMessage(entry))), entry.timeoutMs)
  })
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer))
}

function isComponent(value: unknown): value is ComponentType<Record<string, unknown>> {
  if (typeof value === 'function') return true
  // memo / forwardRef / lazy 返回的是带 $$typeof 的对象
  return typeof value === 'object' && value !== null && '$$typeof' in value
}

export async function loadPluginComponent(entry: SlotEntry): Promise<ComponentType<Record<string, unknown>>> {
  const href = assetHref(entry.url)
  const cssHref = entry.css === null ? null : assetHref(entry.css.url)
  if (entry.requireIntegrity && !integrityCoveredUrls().has(href)) {
    throw new PluginReloadRequired(`${entry.pluginId}@${entry.version} 是页面打开之后才启用的版本`)
  }
  const task = (async () => {
    const [mod] = await Promise.all([
      // 两个注释分别让 webpack 和 Turbopack 原样保留 import()，交给浏览器按 import map 解析
      import(/* webpackIgnore: true */ /* turbopackIgnore: true */ href) as Promise<Record<string, unknown>>,
      cssHref === null ? undefined : loadStylesheet(cssHref, entry.css!.integrity),
    ])
    const component = mod[entry.exportName]
    if (!isComponent(component)) {
      throw new PluginLoadError(`${entry.pluginId}@${entry.version} 没有导出组件 ${entry.exportName}`)
    }
    return component
  })()
  return withTimeout(task, entry)
}
