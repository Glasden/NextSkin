import { can } from '@nextskin/domain'
import { Alert, Badge, Link, PlayerHead, SkinViewer } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { getServer } from '../../../lib/server'
import { getSessionUser } from '../../../lib/session'
import { headSrc, textureFileUrl } from '../../../lib/textures'
import type { ApplyPlayer } from '../../user/closet/apply-texture-dialog'
import { TextureAdminActions } from './admin-actions'
import { TextureOwnerActions } from './owner-actions'
import { ReportTexture, TextureViewerActions } from './viewer-actions'

function parseTid(value: string): number | null {
  return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null
}

/** 当前登录用户：衣柜、角色、头像和积分，供材质的操作用（ADR-0026） */
async function loadViewer(uid: number) {
  const { core } = await getServer()
  const [overview, profile, owned, settings] = await Promise.all([
    core.users.overview(uid),
    core.users.profile(uid),
    core.players.listOwned(uid),
    core.settings.read([
      'score.perClosetItem',
      'score.refundOnDelete',
      'texture.nameRegex',
      'report.cost',
      'report.reward',
      'auth.requireEmailVerification',
    ]),
  ])
  if (!overview || !profile) return null
  const players: ApplyPlayer[] = owned.map((player) => ({
    pid: player.pid,
    name: player.name,
    skin: player.skin?.tid ?? null,
    cape: player.cape?.tid ?? null,
    head: player.skin ? { hash: player.skin.hash, scale: player.skin.scale } : null,
  }))
  return { overview, profile, players, settings }
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

/**
 * 材质详情：3D 预览是视觉中心（DESIGN.md §2）。别人的私有材质与不存在的一样是 404（ADR-0025），有 textures.manage 的人除外：
 * 他们只看得到管理面板，加入衣柜、设为角色的材质、设为头像、举报都不显示（ADR-0036"别人的材质"）
 */
export default async function TexturePage({ params }: { params: Promise<{ tid: string }> }) {
  const texture = await loadTexture((await params).tid)
  if (!texture) notFound()
  const [{ core }, user, t, format] = await Promise.all([
    getServer(),
    getSessionUser(),
    getTranslations('skinlib'),
    getFormatter(),
  ])
  // 别人的私有材质对管理员也只放开查看：不加载衣柜、角色这些操作要用的数据，也就不显示它们
  const viewer = user && user.role !== 'banned' && !texture.othersPrivate ? await loadViewer(user.uid) : null
  const subject = { tid: texture.tid, name: texture.name, type: texture.type }
  const type = t(`types.${texture.type}`)
  const management = texture.management
  const settings = management ? await core.settings.read(['texture.nameRegex']) : null
  // 别人的材质：有 textures.manage 的人可以编辑、下架、删除（ADR-0027、ADR-0036）。上传者自己走上面的 management
  const [adminImpact, adminSettings] =
    user && !management && can(user.role, 'textures.manage')
      ? await Promise.all([
          core.admin.textureDeletionImpact(user.uid, texture.tid),
          core.settings.read(['texture.nameRegex', 'score.refundOnDelete']),
        ])
      : [null, null]
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
            {texture.othersPrivate && <Alert tone="info">{t('detail.othersPrivate')}</Alert>}
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

          {viewer ? (
            <TextureViewerActions
              texture={subject}
              closetItem={texture.closetItem}
              isAvatar={viewer.profile.avatarTid === texture.tid}
              players={viewer.players}
              locked={viewer.settings['auth.requireEmailVerification'] && !viewer.overview.emailVerified}
              score={viewer.overview.score}
              closetCost={viewer.settings['score.perClosetItem']}
              refund={viewer.settings['score.refundOnDelete']}
              nameRegex={viewer.settings['texture.nameRegex']}
            />
          ) : (
            !user && (
              <p className="text-sm text-text-muted">
                <Link render={<NextLink href={`/sign-in?next=${encodeURIComponent(`/skinlib/${texture.tid}`)}`} />}>
                  {t('actions.signIn')}
                </Link>{' '}
                {t('actions.signInHint')}
              </p>
            )
          )}

          <div className="flex items-center gap-3">
            {texture.uploader ? (
              <>
                <PlayerHead
                  src={texture.uploader.avatar ? headSrc(texture.uploader.avatar.hash) : undefined}
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
                <PlayerHead fallback="blank" size={32} alt="" />
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
            {viewer && (
              <ReportTexture
                texture={subject}
                reported={texture.reported}
                cost={viewer.settings['report.cost']}
                reward={viewer.settings['report.reward']}
              />
            )}
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

          {adminImpact && adminSettings && (
            <TextureAdminActions
              texture={{
                tid: texture.tid,
                name: texture.name,
                type: texture.type,
                public: texture.public,
                description: texture.description,
                square: texture.width === texture.height,
                uploaderGone: texture.uploader === null,
              }}
              impact={adminImpact}
              refund={adminSettings['score.refundOnDelete']}
              nameRegex={adminSettings['texture.nameRegex']}
              // 上传者在后台的详情页，要有 users.ban（ADR-0036"页面"）
              uploader={
                texture.uploader && user && can(user.role, 'users.ban')
                  ? { uid: texture.uploader.uid, nickname: texture.uploader.nickname }
                  : null
              }
            />
          )}
        </aside>
      </div>
    </div>
  )
}
