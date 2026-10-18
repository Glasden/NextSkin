import { Badge, Button, EmptyState, Input, Link, Pagination, SkinFigure, TextureCard } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { Image } from 'pixelarticons/react/Image.js'
import { getServer } from '../../lib/server'
import { getSessionUser } from '../../lib/session'
import { figureSrc } from '../../lib/textures'
import { LibraryFilters } from './library-filters'
import { libraryHref, parseLibraryParams, PER_PAGE } from './params'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('skinlib.list')
  return { title: t('title') }
}

/** 皮肤库：只列公开材质；按上传者筛选自己时，私有材质也列出来，这就是“我上传的”（ADR-0025） */
export default async function SkinlibPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = parseLibraryParams(await searchParams)
  const [{ core }, user, t] = await Promise.all([getServer(), getSessionUser(), getTranslations('skinlib')])
  const viewer = user?.uid ?? null
  const { items, total } = await core.textures.list({
    viewer,
    type: params.type,
    sort: params.sort,
    q: params.q || undefined,
    uploader: params.uploader ?? undefined,
    page: params.page,
    perPage: PER_PAGE,
  })
  const pageCount = Math.ceil(total / PER_PAGE)
  const mine = viewer !== null && params.uploader === viewer
  const filtered = params.q !== '' || params.uploader !== null
  const uploaderName = items[0]?.uploaderName

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-baseline gap-3 font-pixel text-pixel-2 text-text">
            {mine ? t('list.mineTitle') : t('list.title')}
            {total > 0 && (
              <span className="text-pixel-1 text-text-muted tabular-nums">{t('list.count', { count: total })}</span>
            )}
          </h1>
          <p className="text-sm text-pretty text-text-muted">
            {mine
              ? t('list.mineDescription')
              : params.uploader !== null
                ? t('list.uploaderDescription', { name: uploaderName ?? `#${params.uploader}` })
                : t('list.description')}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-4 text-sm">
          {params.uploader !== null ? (
            <Link render={<NextLink href={libraryHref(params, { uploader: null })} />}>{t('list.allUploaders')}</Link>
          ) : (
            viewer !== null && (
              <Link render={<NextLink href={libraryHref(params, { uploader: viewer })} />}>{t('list.mine')}</Link>
            )
          )}
          <Link render={<NextLink href="/skinlib/upload" />}>{t('list.upload')}</Link>
        </div>
      </header>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <LibraryFilters params={params} />
        {/* 搜索是普通的 GET 表单，不需要 JS；类型、排序和上传者原样带上 */}
        <form action="/skinlib" role="search" className="flex gap-2 lg:w-80">
          {params.type !== 'skin' && <input type="hidden" name="type" value={params.type} />}
          {params.sort !== 'latest' && <input type="hidden" name="sort" value={params.sort} />}
          {params.uploader !== null && <input type="hidden" name="uploader" value={params.uploader} />}
          <Input
            name="q"
            type="search"
            defaultValue={params.q}
            aria-label={t('list.searchLabel')}
            placeholder={t('list.searchPlaceholder')}
            maxLength={64}
          />
          <Button type="submit">{t('list.search')}</Button>
        </form>
      </div>

      {items.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {items.map((texture) => {
              const type = t(`types.${texture.type}`)
              return (
                <TextureCard
                  key={texture.tid}
                  render={<NextLink href={`/skinlib/${texture.tid}`} />}
                  name={texture.name}
                  figure={
                    <SkinFigure
                      src={figureSrc(texture.hash, texture.type)}
                      type={texture.type}
                      textureScale={texture.scale}
                      scale={4}
                      alt={t('figureAlt', { name: texture.name, type })}
                    />
                  }
                  meta={t('list.meta', { type, likes: texture.likes })}
                  badge={texture.public ? undefined : <Badge>{t('private')}</Badge>}
                  selected={texture.inCloset ? t('inCloset') : undefined}
                />
              )
            })}
          </div>
          <Pagination
            page={params.page}
            pageCount={pageCount}
            href={(page) => libraryHref(params, { page })}
            linkAs={NextLink}
            label={t('list.pagination')}
            previousLabel={t('list.previous')}
            nextLabel={t('list.next')}
            pageLabel={(page) => t('list.page', { page })}
          />
        </>
      ) : mine && params.q === '' && params.page === 1 ? (
        <EmptyState
          icon={<Image />}
          title={t('list.mineEmptyTitle')}
          description={t('list.mineEmptyDescription')}
          action={<Link render={<NextLink href="/skinlib/upload" />}>{t('list.uploadFirst')}</Link>}
        />
      ) : filtered || params.page > 1 ? (
        <EmptyState
          icon={<Image />}
          title={t('list.noResultsTitle')}
          description={t('list.noResultsDescription')}
          action={
            <Link render={<NextLink href={libraryHref(params, { q: '', uploader: null })} />}>
              {t('list.clearFilters')}
            </Link>
          }
        />
      ) : (
        <EmptyState
          icon={<Image />}
          title={t('list.emptyTitle')}
          description={t('list.emptyDescription')}
          action={<Link render={<NextLink href="/skinlib/upload" />}>{t('list.uploadFirst')}</Link>}
        />
      )}
    </div>
  )
}
