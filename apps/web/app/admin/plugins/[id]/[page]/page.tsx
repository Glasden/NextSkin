import type { Metadata } from 'next'
import { getLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { pluginPage } from '../../../../../lib/plugins'
import { getServer } from '../../../../../lib/server'
import { getSessionUser, requireAdmin } from '../../../../../lib/session'
import { PluginPageView } from '../../../../_plugins/plugin-page-view'

type Params = Promise<{ id: string; page: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const [{ id, page }, user, { core }, locale] = await Promise.all([params, getSessionUser(), getServer(), getLocale()])
  const found = user ? await pluginPage('admin', id, page, user) : null
  return found ? { title: core.plugins.translate(id, found.title, locale) } : {}
}

/** 插件声明的后台页面（ADR-0033"UI"）：要求管理员；插件没在运行、没有这个页面时 404 */
export default async function AdminPluginViewPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id, page } = await params
  const basePath = `/admin/plugins/${id}/${page}`
  const user = await requireAdmin(basePath)
  const found = await pluginPage('admin', id, page, user)
  if (!found) notFound()
  return (
    <PluginPageView
      area="admin"
      pluginId={id}
      page={found}
      user={user}
      basePath={basePath}
      searchParams={await searchParams}
    />
  )
}
