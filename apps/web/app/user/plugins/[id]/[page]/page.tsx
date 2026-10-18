import type { Metadata } from 'next'
import { getLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { pluginPage } from '../../../../../lib/plugins'
import { getServer } from '../../../../../lib/server'
import { getSessionUser, requireUser } from '../../../../../lib/session'
import { PluginPageView } from '../../../../_plugins/plugin-page-view'

type Params = Promise<{ id: string; page: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const [{ id, page }, user, { core }, locale] = await Promise.all([params, getSessionUser(), getServer(), getLocale()])
  const found = user ? await pluginPage('user', id, page, user) : null
  return found ? { title: core.plugins.translate(id, found.title, locale) } : {}
}

/** 插件声明的用户中心页面（ADR-0033"UI"）：要求登录；插件没在运行、没有这个页面时 404 */
export default async function UserPluginViewPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id, page } = await params
  const basePath = `/user/plugins/${id}/${page}`
  const user = await requireUser(basePath)
  const found = await pluginPage('user', id, page, user)
  if (!found) notFound()
  return (
    <PluginPageView
      area="user"
      pluginId={id}
      page={found}
      user={user}
      basePath={basePath}
      searchParams={await searchParams}
    />
  )
}
