import { can, outranks, type AdminPlayer } from '@nextskin/domain'
import { Badge, Button, FigurePlaceholder, Input, Link, Pagination, PlayerHead, SkinFigure, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { figureSrc, headSrc } from '../../../lib/textures'
import { ADMIN_PER_PAGE, parsePlayerParams, playersHref } from '../params'
import { roleTones } from '../users/role-changes'
import { PlayerActions } from './player-actions'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.players')
  return { title: t('title') }
}

type Column = 'pid' | 'player' | 'uuid' | 'owner' | 'textures' | 'updatedAt' | 'actions'

/**
 * 后台的角色页（ADR-0036"后台的角色管理"）：服主最常问的是"这个游戏名是谁的"，按角色名或 UUID 查；`?owner=` 列出某个用户的角色，
 * 用户详情页链接到这里。行内操作只给主人身份比自己低的角色显示，能不能做最终由用例按数据库里的身份判断
 */
export default async function AdminPlayersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = parsePlayerParams(await searchParams)
  const viewer = await requireAdmin(playersHref(params, { page: params.page }), 'players.manage')
  const { core } = await getServer()
  const [{ items, total, owner }, mailConfigured, t, admin, skinlib, format] = await Promise.all([
    core.admin.listPlayers(viewer.uid, {
      q: params.q,
      owner: params.owner ?? undefined,
      page: params.page,
      perPage: ADMIN_PER_PAGE,
    }),
    core.mail.configured(),
    getTranslations('admin.players'),
    getTranslations('admin'),
    getTranslations('skinlib'),
    getFormatter(),
  ])
  const pageCount = Math.ceil(total / ADMIN_PER_PAGE)
  const filtered = params.q !== '' || params.owner !== null

  /**
   * 皮肤和披风：一个定宽的迷你展台放 ×3 的正面（DESIGN.md §5，同举报页），披风站在皮肤旁边，各行的编号因此对齐；编号链接到详情页。
   * 认不出尺寸的材质只写编号；别人的私有材质在没有 textures.manage 时只写"私有材质"和编号（ADR-0036"别人的材质"）
   */
  function textures(player: AdminPlayer) {
    const skin = player.skin && !('hidden' in player.skin) ? player.skin : null
    const cape = player.cape && !('hidden' in player.cape) ? player.cape : null
    const model = skin?.type ?? 'steve'
    const caption = (slot: 'skin' | 'cape', texture: AdminPlayer['skin'] | AdminPlayer['cape']) => {
      if (!texture) return <span className="text-text-muted">{t(slot === 'skin' ? 'noSkin' : 'noCape')}</span>
      if ('hidden' in texture)
        return <span className="text-text-muted">{t('hiddenTexture', { slot, tid: texture.tid })}</span>
      // 私有材质的详情页对没有 textures.manage 的管理员是 404（ADR-0025），这样的材质上面已经只写编号了
      return (
        <Link render={<NextLink href={`/skinlib/${texture.tid}`} />}>
          {t(slot === 'skin' ? 'skinLink' : 'capeLink', { tid: texture.tid })}
        </Link>
      )
    }
    return (
      <span className="flex items-center gap-3 py-1">
        <span className="flex h-26 w-24 shrink-0 items-center justify-center gap-1 rounded-sm bg-stage">
          {skin && skin.scale !== null ? (
            <SkinFigure
              src={figureSrc(skin.hash, model)}
              type={model}
              textureScale={skin.scale}
              scale={3}
              alt={skinlib('figureAlt', { name: player.name, type: skinlib(`types.${model}`) })}
            />
          ) : (
            <FigurePlaceholder
              scale={3}
              label={
                !player.skin
                  ? t('noSkin')
                  : 'hidden' in player.skin
                    ? t('hiddenTexture', { slot: 'skin', tid: player.skin.tid })
                    : t('unknownSize', { tid: player.skin.tid })
              }
            />
          )}
          {cape && cape.scale !== null && (
            <SkinFigure
              src={figureSrc(cape.hash, 'cape')}
              type="cape"
              textureScale={cape.scale}
              scale={3}
              alt={skinlib('figureAlt', { name: player.name, type: skinlib('types.cape') })}
            />
          )}
        </span>
        <span className="flex min-w-24 flex-col gap-1 text-sm">
          {caption('skin', player.skin)}
          {caption('cape', player.cape)}
        </span>
      </span>
    )
  }

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
            <Link render={<NextLink href={playersHref({ ...params, owner: null })} />}>{t('clearOwner')}</Link>
          </p>
        ) : (
          <span className="hidden xl:block" />
        )}
        {/* 搜索是普通的 GET 表单，不需要 JS；按主人筛选原样带上 */}
        <form action="/admin/players" role="search" className="flex gap-2 xl:w-96">
          {params.owner !== null && <input type="hidden" name="owner" value={params.owner} />}
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
        empty={filtered ? t('emptyFiltered') : t('empty')}
        columns={[
          { key: 'pid', header: t('columns.pid'), align: 'end', shrink: true },
          { key: 'player', header: t('columns.player') },
          { key: 'uuid', header: t('columns.uuid') },
          { key: 'owner', header: t('columns.owner') },
          { key: 'textures', header: t('columns.textures'), shrink: true },
          { key: 'updatedAt', header: t('columns.updatedAt'), shrink: true },
          { key: 'actions', header: t('columns.actions'), shrink: true },
        ]}
        rows={items.map((player) => {
          const self = player.owner.uid === viewer.uid
          const visibleSkin = player.skin && !('hidden' in player.skin) ? player.skin : null
          return {
            key: player.pid,
            cells: {
              pid: <span className="font-mono">{player.pid}</span>,
              player: (
                <span className="flex min-w-40 items-center gap-2">
                  <PlayerHead
                    src={visibleSkin && visibleSkin.scale !== null ? headSrc(visibleSkin.hash) : undefined}
                    textureScale={visibleSkin?.scale ?? undefined}
                    size={24}
                    alt=""
                  />
                  <span className="min-w-0 font-medium break-all">{player.name}</span>
                </span>
              ),
              uuid: <span className="block min-w-36 font-mono text-xs break-all select-all">{player.uuid}</span>,
              owner: (
                <span className="flex min-w-32 flex-wrap items-center gap-2">
                  <Link render={<NextLink href={`/admin/users/${player.owner.uid}`} />}>{player.owner.nickname}</Link>
                  {self && <Badge>{admin('you')}</Badge>}
                  {player.owner.role !== 'user' && (
                    <Badge tone={roleTones[player.owner.role]}>{admin(`roles.${player.owner.role}`)}</Badge>
                  )}
                </span>
              ),
              textures: textures(player),
              updatedAt: format.dateTime(new Date(player.updatedAt), { dateStyle: 'short', timeStyle: 'short' }),
              actions:
                !self && outranks(viewer.role, player.owner.role) ? (
                  <PlayerActions
                    player={player}
                    emailLookup={can(viewer.role, 'users.ban')}
                    mailConfigured={mailConfigured}
                  />
                ) : null,
            },
          }
        })}
      />

      <Pagination
        page={params.page}
        pageCount={pageCount}
        href={(page) => playersHref(params, { page })}
        linkAs={NextLink}
        label={admin('pagination')}
        previousLabel={admin('previous')}
        nextLabel={admin('next')}
        pageLabel={(page) => admin('page', { page })}
      />
    </div>
  )
}
