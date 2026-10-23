import type {
  PluginAction,
  PluginColumn,
  PluginField,
  PluginReferences,
  PluginView,
  SessionUser,
} from '@nextskin/domain'
import { Alert, Badge, Button, Input, Link, Markdown, Pagination, Panel, PlayerHead, Table } from '@nextskin/ui'
import { getFormatter, getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import type { ReactNode } from 'react'
import { pluginSourceQuery } from '../../lib/plugin-url'
import { getPluginRoute, pluginName, pluginTranslator } from '../../lib/plugins'
import { statsItems } from '../../lib/plugin-widgets'
import { getServer } from '../../lib/server'
import { headSrc } from '../../lib/textures'
import { PluginAction as PluginActionButton } from './plugin-action'
import { PluginFormView } from './plugin-form-view'
import type { PluginActionText, PluginFieldText } from './types'

/** 后台表格每页 50 行（DESIGN.md §6 的 Pagination）；插件的表格同样 */
const PAGE_SIZE = 50

type Translate = ReturnType<typeof pluginTranslator>
type SearchParams = Record<string, string | string[] | undefined>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fieldText(translate: Translate, field: PluginField): PluginFieldText {
  return {
    name: field.name,
    type: field.type,
    label: translate(field.label),
    help: field.help ? translate(field.help) : undefined,
    placeholder: 'placeholder' in field && field.placeholder ? translate(field.placeholder) : undefined,
    required: field.required,
    maxLength: 'maxLength' in field ? field.maxLength : undefined,
    options: (field.type === 'select' ? field.options : undefined)?.map((option) => ({
      value: option.value,
      label: translate(option.label),
    })),
  }
}

function actionText(translate: Translate, action: PluginAction): PluginActionText {
  return {
    label: translate(action.label),
    method: action.method,
    route: action.route,
    tone: action.tone ?? 'default',
    confirm: action.confirm ? translate(action.confirm) : undefined,
    form: action.form?.map((field) => fieldText(translate, field)),
  }
}

/** 插件返回的值写成一行字：对象和数组按 JSON 写 */
function display(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value) ?? ''
}

function param(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 插件声明的一个页面（ADR-0033"UI"）：表格、表单、统计、Markdown 四种视图，用本站的组件渲染（DESIGN.md §11）。
 * 数据在服务端经过和网关相同的权限检查取来；操作从浏览器经 /plugins/{id}/* 网关发出
 */
export async function PluginPageView({
  area,
  pluginId,
  page,
  user,
  basePath,
  searchParams,
}: {
  area: 'user' | 'admin'
  pluginId: string
  page: { title: string; view: PluginView }
  user: SessionUser
  /** 这个页面的地址，分页和搜索用 */
  basePath: string
  searchParams: SearchParams
}) {
  const [{ core }, locale, t] = await Promise.all([getServer(), getLocale(), getTranslations('pluginView')])
  const translate = pluginTranslator(core, pluginId, locale)
  const title = translate(page.title)
  const { view } = page
  let body: ReactNode
  switch (view.kind) {
    case 'table':
      body = await TableView({ area, pluginId, view, user, basePath, searchParams, title, translate })
      break
    case 'stats': {
      const response = await getPluginRoute(user, pluginId, view.source)
      const items = response && response.status === 200 ? statsItems(response.data) : null
      const format = await getFormatter()
      body = items ? (
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {items.map((item) => (
            <Panel key={item.label} padding="md" gap={1}>
              <dt className="text-sm text-text-muted">{translate(item.label)}</dt>
              <dd className="font-pixel text-pixel-2 text-text tabular-nums">
                {typeof item.value === 'number' ? format.number(item.value) : item.value}
              </dd>
            </Panel>
          ))}
        </dl>
      ) : null
      break
    }
    case 'markdown': {
      const response = await getPluginRoute(user, pluginId, view.source)
      body =
        response && response.status === 200 ? (
          <div className="max-w-3xl">
            <Panel padding="responsive">
              {/* 插件页上的代码块多半是要用户复制走的东西，例如发给机器人的一条命令 */}
              <Markdown
                headingLevel={1}
                copy={{ label: t('copyCode'), done: t('codeCopied'), failed: t('copyCodeFailed') }}
              >
                {response.text}
              </Markdown>
            </Panel>
          </div>
        ) : null
      break
    }
    case 'form': {
      const response = view.load ? await getPluginRoute(user, pluginId, view.load) : null
      const initial = !view.load ? {} : response?.status === 200 && isRecord(response.data) ? response.data : null
      body = initial ? (
        <div className="max-w-2xl">
          <PluginFormView
            pluginId={pluginId}
            label={title}
            fields={view.fields.map((field) => fieldText(translate, field))}
            initial={initial}
            submit={{ ...view.submit, label: translate(view.submit.label) }}
          />
        </div>
      ) : null
      break
    }
  }

  // 页面标题和插件名常常是同一个词（例如“邀请码”），一样时只写一次
  const name = pluginName(core, pluginId, locale)
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{title}</h1>
        {name !== title && <p className="text-sm text-text-muted">{name}</p>}
      </header>
      {body ?? <Alert tone="danger">{t('loadFailed')}</Alert>}
    </div>
  )
}

/** 表格视图：`?page=&pageSize=&q=` 交给插件的 source 路由，返回 `{ rows, total }`（SDK 的 TableSourceResponse） */
async function TableView({
  area,
  pluginId,
  view,
  user,
  basePath,
  searchParams,
  title,
  translate,
}: {
  area: 'user' | 'admin'
  pluginId: string
  view: Extract<PluginView, { kind: 'table' }>
  user: SessionUser
  basePath: string
  searchParams: SearchParams
  title: string
  translate: Translate
}): Promise<ReactNode> {
  const [{ core }, t, admin, format] = await Promise.all([
    getServer(),
    getTranslations('pluginView'),
    getTranslations('admin'),
    getFormatter(),
  ])
  const pageNumber = Math.max(1, Math.trunc(Number(param(searchParams.page))) || 1)
  const q = view.searchable ? param(searchParams.q).trim().slice(0, 64) : ''
  const query = new URLSearchParams({ page: String(pageNumber), pageSize: String(PAGE_SIZE) })
  if (q) query.set('q', q)
  const response = await getPluginRoute(user, pluginId, pluginSourceQuery(view.source, query))
  const data = response?.status === 200 && isRecord(response.data) ? response.data : null
  if (!data || !Array.isArray(data.rows) || typeof data.total !== 'number') return null
  const rows = data.rows.filter(isRecord).slice(0, 100)
  const total = Math.max(0, Math.trunc(data.total))
  const pageCount = Math.ceil(total / PAGE_SIZE)

  const valuesOf = (formats: readonly PluginColumn['format'][]) =>
    view.columns
      .filter((column) => formats.includes(column.format))
      .flatMap((column) => rows.map((row) => row[column.key]))
  const references: PluginReferences = await core.plugins.references({
    uids: valuesOf(['user']),
    pids: valuesOf(['player']),
  })

  function cell(column: PluginColumn, value: unknown): ReactNode {
    const empty = <span className="text-text-muted">—</span>
    if (value === null || value === undefined || value === '') return empty
    const id =
      typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null
    switch (column.format) {
      case 'code':
        return <code className="font-mono text-xs whitespace-nowrap">{display(value)}</code>
      case 'number':
        return typeof value === 'number' ? format.number(value) : display(value)
      case 'datetime': {
        const date = new Date(typeof value === 'number' || typeof value === 'string' ? value : NaN)
        return Number.isNaN(date.getTime()) ? empty : format.dateTime(date, { dateStyle: 'short', timeStyle: 'short' })
      }
      case 'boolean':
        return value === true || value === 1 || value === 'true' ? t('yes') : t('no')
      case 'status':
        return <Badge>{display(value)}</Badge>
      case 'user': {
        const found = id === null ? undefined : references.users[id]
        if (!found || id === null) return <span className="font-mono text-xs">#{display(value)}</span>
        const content = (
          <span className="inline-flex items-center gap-2">
            <PlayerHead src={found.avatar ? headSrc(found.avatar.hash) : undefined} size={24} alt="" />
            {found.nickname}
          </span>
        )
        return area === 'admin' ? <Link render={<NextLink href={`/admin/users/${id}`} />}>{content}</Link> : content
      }
      case 'player': {
        const found = id === null ? undefined : references.players[id]
        return found ? found.name : <span className="font-mono text-xs">#{display(value)}</span>
      }
      case 'texture':
        return id === null ? empty : <Link render={<NextLink href={`/skinlib/${id}`} />}>#{id}</Link>
      default:
        return display(value)
    }
  }

  const rowActions = (view.rowActions ?? []).map((action) => actionText(translate, action))
  const toolbar = (view.toolbar ?? []).map((action) => actionText(translate, action))
  const firstKey = view.columns[0]?.key
  const href = (target: number) => {
    const next = new URLSearchParams()
    if (q) next.set('q', q)
    if (target > 1) next.set('page', String(target))
    const search = next.toString()
    return search ? `${basePath}?${search}` : basePath
  }

  return (
    <div className="flex flex-col gap-4">
      {(view.searchable || toolbar.length > 0) && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {toolbar.map((action) => (
              <PluginActionButton key={`${action.method} ${action.route}`} pluginId={pluginId} action={action} />
            ))}
          </div>
          {view.searchable && (
            // 搜索是普通的 GET 表单，不需要 JS
            <form action={basePath} role="search" className="flex gap-2 sm:w-80">
              <Input
                name="q"
                type="search"
                size="sm"
                defaultValue={q}
                aria-label={t('searchLabel', { title })}
                maxLength={64}
              />
              <Button type="submit" size="sm">
                {t('search')}
              </Button>
            </form>
          )}
        </div>
      )}
      <Table<string>
        label={title}
        empty={q ? t('emptySearch') : t('empty')}
        columns={[
          ...view.columns.map((column) => ({
            key: `c:${column.key}`,
            header: translate(column.label),
            align: column.format === 'number' ? ('end' as const) : undefined,
            shrink: column.format === 'datetime' || column.format === 'status' || column.format === 'boolean',
          })),
          ...(rowActions.length ? [{ key: 'actions', header: t('actions'), shrink: true }] : []),
        ]}
        rows={rows.map((row, index) => ({
          key: index,
          cells: {
            ...Object.fromEntries(view.columns.map((column) => [`c:${column.key}`, cell(column, row[column.key])])),
            ...(rowActions.length
              ? {
                  actions: (
                    <span className="flex gap-2">
                      {rowActions.map((action) => (
                        <PluginActionButton
                          key={`${action.method} ${action.route}`}
                          pluginId={pluginId}
                          action={action}
                          row={row}
                          rowLabel={firstKey ? `${action.label} ${display(row[firstKey] ?? '')}` : undefined}
                        />
                      ))}
                    </span>
                  ),
                }
              : {}),
          },
        }))}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-muted">{t('count', { count: total })}</p>
        <Pagination
          page={pageNumber}
          pageCount={pageCount}
          href={href}
          linkAs={NextLink}
          label={admin('pagination')}
          previousLabel={admin('previous')}
          nextLabel={admin('next')}
          pageLabel={(target) => admin('page', { page: target })}
        />
      </div>
    </div>
  )
}
