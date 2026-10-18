import { Badge, Button, EmptyState, Input, Link, Pagination, SkinFigure, TextureCard } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { Shirt } from 'pixelarticons/react/Shirt.js'
import { getServer } from '../../../lib/server'
import { requireUser } from '../../../lib/session'
import { figureSrc } from '../../../lib/textures'
import type { ApplyPlayer } from './apply-texture-dialog'
import { ClosetItemActions } from './closet-item-actions'
import { ClosetTabs } from './closet-tabs'
import { closetHref, parseClosetParams, PER_PAGE } from './params'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('user.closet')
  return { title: t('title') }
}

/** 衣柜：皮肤、披风分两个 Tab，按名字搜索，每页 20 个（ADR-0026） */
export default async function ClosetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const user = await requireUser('/user/closet')
  const params = parseClosetParams(await searchParams)
  const other = params.type === 'skin' ? 'cape' : 'skin'
  const { core } = await getServer()
  const [overview, profile, list, otherList, owned, settings, t, skinlib, common] = await Promise.all([
    core.users.overview(user.uid),
    core.users.profile(user.uid),
    core.closet.list(user.uid, { type: params.type, q: params.q || undefined, page: params.page, perPage: PER_PAGE }),
    // 另一个 Tab 上的数量
    core.closet.list(user.uid, { type: other, q: params.q || undefined, page: 1, perPage: 1 }),
    core.players.listOwned(user.uid),
    core.settings.read([
      'score.perClosetItem',
      'score.refundOnDelete',
      'texture.nameRegex',
      'auth.requireEmailVerification',
    ]),
    getTranslations('user.closet'),
    getTranslations('skinlib'),
    getTranslations('common'),
  ])
  // 会话还在、用户已经被删掉的极少数情况
  if (!overview || !profile) redirect('/sign-in')
  const { items, total } = list
  const pageCount = Math.ceil(total / PER_PAGE)
  const refund = settings['score.refundOnDelete']
  const locked = settings['auth.requireEmailVerification'] && !overview.emailVerified
  const players: ApplyPlayer[] = owned.map((player) => ({
    pid: player.pid,
    name: player.name,
    skin: player.skin?.tid ?? null,
    cape: player.cape?.tid ?? null,
    head: player.skin ? { hash: player.skin.hash, scale: player.skin.scale } : null,
  }))
  const counts = { [params.type]: total, [other]: otherList.total } as Record<'skin' | 'cape', number>

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
          <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
          <p className="text-sm text-pretty text-text-muted">
            {settings['score.perClosetItem'] > 0
              ? common('sentences', {
                  first: t('cost', { cost: settings['score.perClosetItem'] }),
                  second: t('refundPolicy', { refund: String(refund) }),
                })
              : t('cost', { cost: 0 })}
          </p>
        </div>
        <div className="shrink-0 text-sm">
          <Link render={<NextLink href="/skinlib" />}>{t('browse')}</Link>
        </div>
      </header>

      <ClosetTabs params={params} counts={counts}>
        <div className="flex flex-col gap-6">
          {/* 搜索是普通的 GET 表单，不需要 JS；分类原样带上 */}
          <form action="/user/closet" role="search" className="flex gap-2 sm:w-80">
            {params.type !== 'skin' && <input type="hidden" name="type" value={params.type} />}
            <Input
              name="q"
              type="search"
              defaultValue={params.q}
              aria-label={t('searchLabel')}
              placeholder={t('searchPlaceholder')}
              maxLength={64}
            />
            <Button type="submit">{t('search')}</Button>
          </form>

          {items.length > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                {items.map((item) => {
                  const type = skinlib(`types.${item.type}`)
                  return (
                    <TextureCard
                      key={item.tid}
                      render={<NextLink href={`/skinlib/${item.tid}`} />}
                      name={item.name}
                      figure={
                        <SkinFigure
                          src={figureSrc(item.hash, item.type)}
                          type={item.type}
                          textureScale={item.scale}
                          scale={4}
                          alt={skinlib('figureAlt', { name: item.name, type })}
                        />
                      }
                      meta={
                        // 原名可能很长：截成一行，卡片高度对齐
                        <span className="min-w-0 truncate">
                          {item.name === item.textureName
                            ? t('meta', { type })
                            : t('metaRenamed', { type, name: item.textureName })}
                        </span>
                      }
                      badge={item.public ? undefined : <Badge>{skinlib('private')}</Badge>}
                      actions={
                        <ClosetItemActions
                          item={{
                            tid: item.tid,
                            name: item.name,
                            type: item.type,
                            refund: refund ? item.scorePaid : 0,
                          }}
                          players={players}
                          locked={locked}
                          nameRegex={settings['texture.nameRegex']}
                          isAvatar={profile.avatarTid === item.tid}
                        />
                      }
                    />
                  )
                })}
              </div>
              <Pagination
                page={params.page}
                pageCount={pageCount}
                href={(page) => closetHref(params, { page })}
                linkAs={NextLink}
                label={t('pagination')}
                previousLabel={t('previous')}
                nextLabel={t('next')}
                pageLabel={(page) => t('page', { page })}
              />
            </>
          ) : params.q !== '' ? (
            <EmptyState
              icon={<Shirt />}
              title={t('noResultsTitle', { q: params.q })}
              description={t('noResultsDescription')}
              action={<Link render={<NextLink href={closetHref(params, { q: '' })} />}>{t('clearSearch')}</Link>}
            />
          ) : total > 0 ? (
            // 页码超出了范围，例如移出最后一页的最后一件之后刷新
            <EmptyState
              icon={<Shirt />}
              title={t('outOfRangeTitle')}
              description={t('outOfRangeDescription', { count: pageCount })}
              action={<Link render={<NextLink href={closetHref(params, { page: 1 })} />}>{t('firstPage')}</Link>}
            />
          ) : (
            <EmptyState
              icon={<Shirt />}
              title={t('emptyTitle', { type: params.type })}
              description={t('emptyDescription')}
              action={
                <Link render={<NextLink href={params.type === 'cape' ? '/skinlib?type=cape' : '/skinlib'} />}>
                  {t('emptyAction')}
                </Link>
              }
            />
          )}
        </div>
      </ClosetTabs>
    </div>
  )
}
