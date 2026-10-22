import { can, outranks } from '@nextskin/domain'
import { Badge, Button, Input, Link, Pagination, PlayerHead, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { headSrc } from '../../../lib/textures'
import { ADMIN_PER_PAGE, parseUserParams, roleOrNull, usersHref } from '../params'
import { RoleFilter } from './role-filter'
import { roleChanges, roleTones } from './role-changes'
import { UserActions } from './user-actions'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.users')
  return { title: t('title') }
}

type Column = 'uid' | 'user' | 'email' | 'role' | 'score' | 'registeredAt' | 'actions'

/**
 * 用户列表（ADR-0027）：按 UID、邮箱、昵称搜索，按身份筛选，按 UID 从新到旧。昵称链接到详情页（ADR-0036），
 * 行内的身份菜单只给身份比自己低的用户显示；能不能做，最终由用例按数据库里的身份判断
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = parseUserParams(await searchParams)
  const viewer = await requireAdmin(usersHref(params, { page: params.page }), 'users.ban')
  const { core } = await getServer()
  const [{ items, total }, t, admin, format] = await Promise.all([
    core.admin.listUsers(viewer.uid, {
      q: params.q,
      role: roleOrNull(params.role),
      page: params.page,
      perPage: ADMIN_PER_PAGE,
    }),
    getTranslations('admin.users'),
    getTranslations('admin'),
    getFormatter(),
  ])
  const pageCount = Math.ceil(total / ADMIN_PER_PAGE)
  const canAppoint = can(viewer.role, 'users.appointAdmin')

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
        <RoleFilter params={params} />
        {/* 搜索是普通的 GET 表单，不需要 JS；角色筛选原样带上 */}
        <form action="/admin/users" role="search" className="flex gap-2 xl:w-96">
          {params.role !== 'all' && <input type="hidden" name="role" value={params.role} />}
          <Input
            name="q"
            type="search"
            size="sm"
            defaultValue={params.q}
            aria-label={t('searchLabel')}
            placeholder={t('searchPlaceholder')}
            maxLength={64}
          />
          <Button type="submit" size="sm">
            {t('search')}
          </Button>
        </form>
      </div>

      <Table<Column>
        label={t('tableLabel')}
        empty={t('empty')}
        columns={[
          { key: 'uid', header: t('columns.uid'), align: 'end', shrink: true },
          { key: 'user', header: t('columns.user') },
          { key: 'email', header: t('columns.email') },
          { key: 'role', header: t('columns.role'), shrink: true },
          { key: 'score', header: t('columns.score'), align: 'end', shrink: true },
          { key: 'registeredAt', header: t('columns.registeredAt'), shrink: true },
          { key: 'actions', header: t('columns.actions'), shrink: true },
        ]}
        rows={items.map((user) => {
          const self = user.uid === viewer.uid
          return {
            key: user.uid,
            cells: {
              uid: <span className="font-mono">{user.uid}</span>,
              user: (
                <span className="flex min-w-40 items-center gap-2">
                  <PlayerHead src={user.avatar ? headSrc(user.avatar.hash) : undefined} size={24} alt="" />
                  <span className="min-w-0 truncate">
                    <Link render={<NextLink href={`/admin/users/${user.uid}`} />}>{user.nickname}</Link>
                  </span>
                  {self && <Badge>{admin('you')}</Badge>}
                </span>
              ),
              email: (
                <span className="flex min-w-48 flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all">{user.email}</span>
                  {!user.emailVerified && <Badge tone="warning">{t('unverified')}</Badge>}
                </span>
              ),
              role: <Badge tone={roleTones[user.role]}>{admin(`roles.${user.role}`)}</Badge>,
              score: format.number(user.score),
              registeredAt: format.dateTime(new Date(user.registeredAt), { dateStyle: 'short', timeStyle: 'short' }),
              actions:
                !self && outranks(viewer.role, user.role) ? (
                  <UserActions
                    user={{ uid: user.uid, nickname: user.nickname, role: user.role }}
                    changes={roleChanges(user.role, canAppoint)}
                  />
                ) : null,
            },
          }
        })}
      />

      <Pagination
        page={params.page}
        pageCount={pageCount}
        href={(page) => usersHref(params, { page })}
        linkAs={NextLink}
        label={admin('pagination')}
        previousLabel={admin('previous')}
        nextLabel={admin('next')}
        pageLabel={(page) => admin('page', { page })}
      />
    </div>
  )
}
