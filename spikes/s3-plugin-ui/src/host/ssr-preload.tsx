import { cookies } from 'next/headers'
import type { SlotEntry } from './types'

/**
 * 可选：服务端渲染时就写出 <link rel="modulepreload">，省掉"水合 → 发请求"的等待。cookie s3-ssr-preload 控制：
 *   'link'：渲染 <link> 元素，React 19 会把它提到 <head>；
 *   'hint'：调用 ReactDOM.preloadModule()。
 * 用来验证它们在 HTML 里是否排在 import map 之后。不写 integrity 属性：modulepreload 没有该属性时，浏览器取 import map 里的 integrity。
 */
export async function SsrPreload({ entries }: { readonly entries: readonly SlotEntry[] }) {
  const how = (await cookies()).get('s3-ssr-preload')?.value
  if (how === 'hint') {
    const { preloadModule } = await import('react-dom')
    for (const entry of entries) preloadModule(entry.url, { as: 'script' })
    return null
  }
  if (how !== 'link') return null
  return entries.map((entry) => <link key={`${entry.pluginId}:${entry.url}`} rel="modulepreload" href={entry.url} />)
}
