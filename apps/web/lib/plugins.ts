import { canPlugin, resolveClientIp, type Core, type SessionUser } from '@nextskin/domain'
import { getLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import * as icons from 'pixelarticons/react'
import { Blocks } from 'pixelarticons/react/Blocks.js'
import { createElement, type ReactElement } from 'react'
import { peerAddress } from './peer-address'
import { getServer } from './server'
import { getRequestRoot } from './session'

// 插件声明的界面（ADR-0033"UI"）由核心渲染：这里是服务端组件共用的几个函数

/** 插件写的图标名是 pixelarticons 的文件名（kebab-case），例如 `mail`、`cloud-server`；认不出来的换成积木 */
export function pluginIcon(name: string): ReactElement {
  const component = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
    ? (icons as Record<string, unknown>)[name.replace(/(?:^|-)([a-z0-9])/g, (_, c: string) => c.toUpperCase())]
    : undefined
  return createElement(typeof component === 'function' ? (component as typeof Blocks) : Blocks)
}

/** 插件的文案：缺了就显示键名，作者一眼就能看出来 */
export function pluginTranslator(core: Core, pluginId: string, locale: string) {
  return (key: string, params?: Readonly<Record<string, string | number>>) =>
    core.plugins.translate(pluginId, key, locale, params)
}

/** 插件的名字和简介按约定取 `plugin.name`、`plugin.description`；没写名字就用 id */
export function pluginName(core: Core, pluginId: string, locale: string): string {
  const name = core.plugins.translate(pluginId, 'plugin.name', locale)
  return name === 'plugin.name' ? pluginId : name
}

export function pluginDescription(core: Core, pluginId: string, locale: string): string | null {
  const text = core.plugins.translate(pluginId, 'plugin.description', locale)
  return text === 'plugin.description' ? null : text
}

export interface PluginNavItem {
  href: string
  label: string
  icon: ReactElement
}

type PluginPageDefinition = NonNullable<ReturnType<Core['plugins']['activeUi']>[number]['ui']['pages']>[string]

/**
 * 当前用户能不能看插件的这个页面：区域要对得上；后台的页面要求管理员，声明了 permission 的页面要求这个插件权限。
 * 第一版的插件权限固定给管理员和超级管理员（SDK 的 routes.ts），用户中心里声明了 permission 的页面也一样
 */
function canSeePage(area: 'user' | 'admin', page: PluginPageDefinition | undefined, user: SessionUser): boolean {
  if (!page || page.area !== area || user.role === 'banned') return false
  if (area === 'admin' || page.permission !== undefined) return canPlugin(user.role)
  return true
}

/** 插件声明的导航项：指向的页面要存在，并且当前用户能看 */
export async function pluginNavItems(area: 'user' | 'admin', user: SessionUser): Promise<PluginNavItem[]> {
  if (user.role === 'banned' || (area === 'admin' && !canPlugin(user.role))) return []
  const [{ core }, locale] = await Promise.all([getServer(), getLocale()])
  return core.plugins.activeUi().flatMap(({ id, ui }) =>
    (ui.nav ?? [])
      .filter((item) => item.area === area && canSeePage(area, ui.pages?.[item.page], user))
      .map((item) => ({
        href: `/${area}/plugins/${id}/${item.page}`,
        label: core.plugins.translate(id, item.label, locale),
        icon: pluginIcon(item.icon),
      })),
  )
}

/** 当前用户能看的插件页面；不存在、插件没在运行、区域不对或者没有权限都返回 null，页面按 404 处理 */
export async function pluginPage(area: 'user' | 'admin', pluginId: string, page: string, user: SessionUser) {
  const { core } = await getServer()
  const found = core.plugins.activeUi().find((item) => item.id === pluginId)
  const definition = found?.ui.pages && Object.hasOwn(found.ui.pages, page) ? found.ui.pages[page] : undefined
  return definition && canSeePage(area, definition, user) ? definition : null
}

export interface PluginResponse {
  status: number
  /** 响应是 JSON 时解析好的值 */
  data: unknown
  text: string
  contentType: string
}

/**
 * 服务端组件里调用插件的 GET 路由（表格、统计、Markdown 的数据源，表单的初始值），和浏览器经过网关一样检查权限，
 * 只是不走 HTTP。插件出错、超时、没有这条路由都返回 null：页面显示“没能加载”，不整页报错
 */
export async function getPluginRoute(
  user: SessionUser,
  pluginId: string,
  pathWithQuery: string,
): Promise<PluginResponse | null> {
  const [{ core }, headerList, root, locale] = await Promise.all([
    getServer(),
    headers(),
    getRequestRoot(),
    getLocale(),
  ])
  const url = new URL(`/plugins/${pluginId}${pathWithQuery}`, root)
  const { 'network.trustedProxies': trustedProxies } = await core.settings.read(['network.trustedProxies'])
  const ip =
    resolveClientIp({
      forwardedFor: headerList.get('x-forwarded-for'),
      peer: peerAddress(headerList),
      trustedProxies,
    }) ?? ''
  try {
    const response = await core.plugins.route({
      pluginId,
      method: 'GET',
      path: url.pathname.slice(`/plugins/${pluginId}`.length) || '/',
      request: { method: 'GET', url: url.href, headers: [['accept', 'application/json']], body: null },
      user: { uid: user.uid, role: user.role },
      ip,
      locale,
    })
    const text = response.body ? new TextDecoder().decode(response.body) : ''
    const contentType = response.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
    let data: unknown = null
    if (/^application\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
      try {
        data = JSON.parse(text) as unknown
      } catch {
        data = null
      }
    }
    return { status: response.status, data, text, contentType }
  } catch {
    return null
  }
}
