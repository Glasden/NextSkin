import { apiError, sendJson } from '../../lib/api-client'
import { pluginUrl } from '../../lib/plugin-url'

/** 表格的行动作的路径里可以写 `:字段`，换成这一行的值（SDK 的 ui.ts） */
export function fillRoute(route: string, row?: Readonly<Record<string, unknown>>): string {
  return route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_, name: string) => {
    const value = row?.[name]
    if (
      (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) ||
      value === '.' ||
      value === '..'
    )
      throw new Error('invalid plugin route parameter')
    return encodeURIComponent(String(value))
  })
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 从浏览器调用插件的路由（经过 /plugins/{id}/* 网关）。插件的响应格式没有规定：成功时取 `message`，
 * 失败时取插件的 `error`、`message`，或者网关的错误（插件出错、没有权限……）
 */
export async function callPlugin(
  pluginId: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; message: string | null }> {
  const url = pluginUrl(pluginId, path, 'https://plugin.invalid')
  const { status, data } = await sendJson(method, url.pathname + url.search, body)
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  if (status >= 200 && status < 300) return { ok: true, message: text(record.message) }
  return { ok: false, message: apiError(data)?.message ?? text(record.error) ?? text(record.message) }
}
