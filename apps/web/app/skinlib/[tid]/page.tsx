import { Badge, Link, PlayerHead, SkinViewer } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { getServer } from '../../../lib/server'
import { getSessionUser } from '../../../lib/session'
import { headSrc, textureFileUrl } from '../../../lib/textures'
import { TextureOwnerActions } from './owner-actions'

function parseTid(value: string): number | null {
  return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null
}

/** 同一次渲染里，metadata 和页面只查一次 */
const loadTexture = cache(async (value: string) => {
  const tid = parseTid(value)
  if (tid === null) return null
  const [{ core }, user] = await Promise.all([getServer(), getSessionUser()])
  return core.textures.detail(user?.uid ?? null, tid)
})

export async function generateMetadata({ params }: { params: Promise<{ tid: string }> }): Promise<Metadata> {
  const texture = await loadTexture((await params).tid)
  const t = await getTranslations('skinlib.detail')
  return { title: texture ? texture.name : t('notFound') }
}

/** 材质详情：3D 预览是视觉中心（DESIGN.md §2）。别人的私有材质与不存在的一样是 404（ADR-0025） */
export default async function TexturePage({ params }: { params: Promise<{ tid: string }> }) {
  const texture = await loadTexture((await params).tid)
  if (!texture) notFound()
  const [{ core }, t, format] = await Promise.all([getServer(), getTranslations('skinlib'), getFormatter()])
  const type = t(`types.${texture.type}`)
  const management = texture.management
  const settings = management ? await core.settings.read(['texture.nameRegex']) : null
  const uploaded = format.dateTime(new Date(texture.uploadedAt), { dateStyle: 'medium' })

  return (
    <div className="flex flex-col gap-6">
      <Link render={<NextLink href="/skinlib" />}>{t('detail.back')}</Link>
      <div className="grid gap-8 lg:grid-cols-5">
        <section className="min-w-0 lg:col-span-3">
          <SkinViewer
            src={textureFileUrl(texture.hash)}
            type={texture.type}
            labels={{
              viewer: t('detail.viewer', { name: texture.name }),
              animation: t('detail.animation'),
              idle: t('detail.idle'),
              walk: t('detail.walk'),
              run: t('detail.run'),
              outerLayer: t('detail.outerLayer'),
              loading: t('detail.loading'),
              failed: t('detail.failed'),
            }}
          />
        </section>
        <aside className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <header className="flex flex-col gap-3">
            <h1 className="text-xl font-medium break-words text-text">{texture.name}</h1>
            <div className="flex flex-wrap gap-2">
              <Badge>{type}</Badge>
              {!texture.public && <Badge>{t('private')}</Badge>}
              {texture.inCloset && <Badge tone="success">{t('inCloset')}</Badge>}
            </div>
          </header>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border border-border bg-surface p-4">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-text-muted">{t('detail.likes')}</dt>
              <dd className="font-pixel text-pixel-2 text-text tabular-nums">{texture.likes}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-text-muted">{t('detail.size')}</dt>
              <dd className="font-pixel text-pixel-2 text-text tabular-nums">
                {texture.width}×{texture.height}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-text-muted">{t('detail.fileSize')}</dt>
              <dd className="text-sm text-text tabular-nums">
                {t('detail.kilobytes', { size: Math.ceil(texture.sizeBytes / 1024) })}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-text-muted">{t('detail.uploadedAt')}</dt>
              <dd className="text-sm text-text">{uploaded}</dd>
            </div>
          </dl>

          <div className="flex items-center gap-3">
            {texture.uploader ? (
              <>
                <PlayerHead
                  src={texture.uploader.avatar ? headSrc(texture.uploader.avatar.hash) : undefined}
                  textureScale={texture.uploader.avatar?.scale}
                  size={32}
                  alt=""
                />
                <div className="flex min-w-0 flex-col">
                  <span className="text-xs text-text-muted">{t('detail.uploader')}</span>
                  <Link render={<NextLink href={`/skinlib?uploader=${texture.uploader.uid}`} />}>
                    {texture.uploader.nickname}
                  </Link>
                </div>
              </>
            ) : (
              <>
                <PlayerHead size={32} alt="" />
                <span className="text-sm text-text-muted">{t('detail.uploaderGone')}</span>
              </>
            )}
          </div>

          <section className="flex flex-col gap-2">
            <h2 className="font-pixel text-pixel-1 text-text-muted">{t('detail.description')}</h2>
            {texture.description ? (
              <p className="text-base break-words whitespace-pre-line text-text">{texture.description}</p>
            ) : (
              <p className="text-sm text-text-muted">{t('detail.noDescription')}</p>
            )}
          </section>

          <div className="flex flex-wrap items-center gap-4 border-t border-border pt-4 text-sm">
            <Link href={textureFileUrl(texture.hash)} download={`${texture.name}.png`}>
              {t('detail.download')}
            </Link>
          </div>

          {management && settings && (
            <TextureOwnerActions
              texture={{
                tid: texture.tid,
                name: texture.name,
                type: texture.type,
                public: texture.public,
                description: texture.description,
                square: texture.width === texture.height,
              }}
              management={management}
              nameRegex={settings['texture.nameRegex']}
            />
          )}
        </aside>
      </div>
    </div>
  )
}
