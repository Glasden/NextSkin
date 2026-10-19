/** 规范化后仍须留在本插件的命名空间。浏览器和服务端数据源共用。 */
export function pluginUrl(pluginId: string, path: string, root: string): URL {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(pluginId) || !path.startsWith('/')) throw new Error('invalid plugin path')
  const base = new URL(root)
  const prefix = `/plugins/${pluginId}`
  const url = new URL(`${prefix}${path}`, base)
  if (url.origin !== base.origin || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)))
    throw new Error('invalid plugin path')
  return url
}

export function pluginSourceQuery(source: string, params: URLSearchParams): string {
  const url = new URL(source, 'https://plugin.invalid')
  for (const [key, value] of params) url.searchParams.set(key, value)
  return url.pathname + url.search
}
