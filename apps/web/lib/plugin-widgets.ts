import { canPlugin, type PluginSlotName, type PluginView, type PluginWidgetView, type UserRole } from '@nextskin/domain'

// 插件放在首页上的挂件（ADR-0059）：挑出当前用户看得到的、把数据源的响应变成要显示的内容。
// 不碰请求和会话，取数据在 lib/plugins.ts

/** 挂件的数据源只等这么久，首页是登录以后的第一页（页面的数据源是 30 秒） */
export const WIDGET_TIMEOUT_MS = 3000
/** 首页上的统计是概要，多的不显示 */
export const WIDGET_STATS_LIMIT = 4

export const SLOT_AREA = { 'user.dashboard': 'user', 'admin.dashboard': 'admin' } as const satisfies Record<
  PluginSlotName,
  'user' | 'admin'
>

interface WidgetDefinition {
  name: string
  slot: PluginSlotName
  title: string
  permission?: string
  link?: { page: string; label: string }
  view: PluginWidgetView
}

interface PluginUi {
  id: string
  ui: {
    pages?: Readonly<Record<string, { area: 'user' | 'admin'; permission?: string }>>
    widgets?: readonly WidgetDefinition[]
  }
}

export interface VisibleWidget {
  pluginId: string
  widget: WidgetDefinition
  /** 标题右边的链接；看的人没有权限看那个页面时没有 */
  href: string | null
}

/**
 * 这个插槽里当前用户看得到的挂件，按插件 id、再按声明的顺序。封禁的用户看不到；后台概览上的、声明了 permission 的
 * 要求插件权限（第一版就是管理员和超级管理员，同插件页面）
 */
export function visibleWidgets(plugins: readonly PluginUi[], slot: PluginSlotName, role: UserRole): VisibleWidget[] {
  if (role === 'banned') return []
  const area = SLOT_AREA[slot]
  return [...plugins]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap(({ id, ui }) =>
      (ui.widgets ?? [])
        .filter(
          (widget) =>
            widget.slot === slot && (area === 'user' && widget.permission === undefined ? true : canPlugin(role)),
        )
        .map((widget) => {
          const page =
            widget.link && ui.pages && Object.hasOwn(ui.pages, widget.link.page)
              ? ui.pages[widget.link.page]
              : undefined
          const canSee =
            page !== undefined &&
            page.area === area &&
            (area === 'admin' || page.permission !== undefined ? canPlugin(role) : true)
          return {
            pluginId: id,
            widget,
            href: canSee && widget.link ? `/${area}/plugins/${id}/${widget.link.page}` : null,
          }
        }),
    )
}

export type WidgetContent =
  { kind: 'stats'; items: { label: string; value: string | number }[] } | { kind: 'markdown'; text: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 统计数据源返回的项（SDK 的 StatsSourceResponse），形状不对时返回 null。插件页面也用它 */
export function statsItems(data: unknown): { label: string; value: string | number }[] | null {
  if (!isRecord(data) || !Array.isArray(data.items)) return null
  return data.items.filter(
    (item): item is { label: string; value: string | number } =>
      isRecord(item) &&
      typeof item.label === 'string' &&
      (typeof item.value === 'string' || typeof item.value === 'number'),
  )
}

/**
 * 数据源的响应变成挂件的内容：204 返回 'hidden'，整个挂件不显示；没响应（出错、超时、host 不可用）、
 * 其他状态码、形状不对返回 null，显示"没能加载"
 */
export function widgetContent(
  view: Extract<PluginView, { kind: 'stats' | 'markdown' }>,
  response: { status: number; data: unknown; text: string } | null,
): WidgetContent | 'hidden' | null {
  if (!response) return null
  if (response.status === 204) return 'hidden'
  if (response.status !== 200) return null
  if (view.kind === 'markdown') return { kind: 'markdown', text: response.text }
  const items = statsItems(response.data)
  return items ? { kind: 'stats', items: items.slice(0, WIDGET_STATS_LIMIT) } : null
}
