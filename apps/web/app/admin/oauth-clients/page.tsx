import { outranks, type AdminOAuthClient, type SessionUser } from '@nextskin/domain'
import { Badge, Button, Input, Link, Pagination, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { Globe } from 'pixelarticons/react/Globe.js'
import { Monitor } from 'pixelarticons/react/Monitor.js'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { ADMIN_PER_PAGE, oauthClientsHref, parseOAuthClientParams } from '../params'
import { roleTones } from '../users/role-changes'
import { AdminClientActions } from './client-actions'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.oauthClients')
  return { title: t('title') }
}

type Column = 'id' | 'client' | 'clientId' | 'owner' | 'status' | 'authorizedUsers' | 'createdAt' | 'actions'

/**
 * 能不能处理这个应用（ADR-0037"后台的'OAuth 应用'"）：按主人的身份判断，自己的到用户中心改；没有主人的
 * （公用应用、导入时主人已经不在的）按管理员算，只有超级管理员能处理。最终由用例按数据库里的身份判断
 */
function manageable(viewer: SessionUser, client: AdminOAuthClient): boolean {
  if (!client.owner) return outranks(viewer.role, 'admin')
  return client.owner.uid !== viewer.uid && outranks(viewer.role, client.owner.role)
}

/**
 * 后台的 OAuth 应用页：全部应用，按名称或 client_id 查找，`?owner=` 列出某个用户名下的，用户详情页链接到这里。
 * 公用应用排在最前面。后台只能停用、启用、删除，不能改别人应用的配置
 */
export default async function AdminOAuthClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = parseOAuthClientParams(await searchParams)
  const viewer = await requireAdmin(oauthClientsHref(params, { page: params.page }), 'oauthClients.manage')
  const { core } = await getServer()
  const [{ items, total, owner }, settings, mailConfigured, t, admin, oauth, format] = await Promise.all([
    core.admin.listOAuthClients(viewer.uid, {
      q: params.q || undefined,
      owner: params.owner ?? undefined,
      page: params.page,
      perPage: ADMIN_PER_PAGE,
    }),
    core.settings.read(['site.name']),
    core.mail.configured(),
    getTranslations('admin.oauthClients'),
    getTranslations('admin'),
    getTranslations('oauth'),
    getFormatter(),
  ])
  const pageCount = Math.ceil(total / ADMIN_PER_PAGE)
  const filtered = params.q !== '' || params.owner !== null
  const nameOf = (client: AdminOAuthClient) =>
    client.shared ? oauth('sharedClient', { site: settings['site.name'] }) : (client.name ?? oauth('unnamedClient'))

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-baseline gap-3 font-pixel text-pixel-2 text-text">
          {t('title')}
          <span className="text-pixel-1 text-text-muted tabular-nums">{t('count', { count: total })}</span>
        </h1>
        <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        {owner !== undefined ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text">
            {owner ? (
              <>
                <span className="font-medium">{t('ownerFilter', { nickname: owner.nickname })}</span>
                <Link render={<NextLink href={`/admin/users/${owner.uid}`} />}>{t('ownerDetail')}</Link>
              </>
            ) : (
              <span className="text-text-muted">{t('ownerGone', { uid: params.owner ?? 0 })}</span>
            )}
            <Link render={<NextLink href={oauthClientsHref({ ...params, owner: null })} />}>{t('clearOwner')}</Link>
          </p>
        ) : (
          <span className="hidden xl:block" />
        )}
        {/* 搜索是普通的 GET 表单，不需要 JS；按主人筛选原样带上 */}
        <form action="/admin/oauth-clients" role="search" className="flex gap-2 xl:w-96">
          {params.owner !== null && <input type="hidden" name="owner" value={params.owner} />}
          <Input
            name="q"
            type="search"
            size="sm"
            defaultValue={params.q}
            aria-label={t('searchLabel')}
            placeholder={t('searchPlaceholder')}
            maxLength={255}
          />
          <Button type="submit" size="sm">
            {t('search')}
          </Button>
        </form>
      </div>

      <Table<Column>
        label={t('tableLabel')}
        empty={filtered ? t('emptyFiltered') : t('empty')}
        columns={[
          { key: 'id', header: t('columns.id'), align: 'end', shrink: true },
          { key: 'client', header: t('columns.client') },
          { key: 'clientId', header: t('columns.clientId') },
          { key: 'owner', header: t('columns.owner') },
          { key: 'status', header: t('columns.status'), shrink: true },
          { key: 'authorizedUsers', header: t('columns.authorizedUsers'), align: 'end', shrink: true },
          { key: 'createdAt', header: t('columns.createdAt'), shrink: true },
          { key: 'actions', header: t('columns.actions'), shrink: true },
        ]}
        rows={items.map((client) => {
          const name = nameOf(client)
          const Icon = client.type === 'web' ? Globe : Monitor
          return {
            key: client.id,
            cells: {
              id: <span className="font-mono">{client.id}</span>,
              client: (
                <span className="flex min-w-48 items-start gap-2">
                  <Icon aria-hidden className="shrink-0 text-text-muted" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    {/* 应用名是用户填的，完整显示（同同意页），用正文字体 */}
                    <span className="font-medium wrap-anywhere">{name}</span>
                    <span className="text-xs text-text-muted">
                      {client.shared ? t('sharedType') : t(`types.${client.type}`)}
                    </span>
                  </span>
                </span>
              ),
              clientId: (
                <span className="block min-w-24 font-mono text-xs break-all select-all">{client.clientId}</span>
              ),
              owner: client.owner ? (
                <span className="flex min-w-32 flex-wrap items-center gap-2">
                  <Link render={<NextLink href={`/admin/users/${client.owner.uid}`} />}>{client.owner.nickname}</Link>
                  {client.owner.uid === viewer.uid && <Badge>{admin('you')}</Badge>}
                  {client.owner.role !== 'user' && (
                    <Badge tone={roleTones[client.owner.role]}>{admin(`roles.${client.owner.role}`)}</Badge>
                  )}
                </span>
              ) : (
                <span className="text-text-muted">{client.shared ? t('ownerSite') : t('ownerNone')}</span>
              ),
              status: client.disabled ? (
                <Badge tone="danger">{t('statusDisabled')}</Badge>
              ) : (
                <Badge tone="success">{t('statusEnabled')}</Badge>
              ),
              authorizedUsers: <span className="tabular-nums">{format.number(client.authorizedUsers)}</span>,
              createdAt: format.dateTime(new Date(client.createdAt), { dateStyle: 'short', timeStyle: 'short' }),
              actions: manageable(viewer, client) ? (
                <AdminClientActions
                  client={{
                    id: client.id,
                    name,
                    shared: client.shared,
                    disabled: client.disabled,
                    authorizedUsers: client.authorizedUsers,
                    notifyOwner: client.owner !== null && mailConfigured,
                  }}
                />
              ) : null,
            },
          }
        })}
      />

      <Pagination
        page={params.page}
        pageCount={pageCount}
        href={(page) => oauthClientsHref(params, { page })}
        linkAs={NextLink}
        label={admin('pagination')}
        previousLabel={admin('previous')}
        nextLabel={admin('next')}
        pageLabel={(page) => admin('page', { page })}
      />
    </div>
  )
}
