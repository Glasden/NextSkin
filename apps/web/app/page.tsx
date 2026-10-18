import type { Podium as PodiumData } from '@nextskin/domain'
import { ButtonLink, EmptyState, Link, Podium, SkinFigure, ToastProvider } from '@nextskin/ui'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { Image } from 'pixelarticons/react/Image.js'
import { Upload } from 'pixelarticons/react/Upload.js'
import { getServer } from '../lib/server'
import { getRequestRoot, getSessionUser } from '../lib/session'
import { figureSrc } from '../lib/textures'
import { yggdrasilApiUrl } from '../lib/yggdrasil'
import { SiteFooter } from './site-footer'
import { SiteHeader } from './site-header'
import { LibraryCard } from './skinlib/library-card'
import { LauncherCopyButton } from './user/launcher-copy-button'

// 最新上传：窄屏 2 列、宽屏 5 列，10 个正好排满（ADR-0032）
const LATEST = 10
const STEPS = ['player', 'launcher', 'wear'] as const

/**
 * 首页（ADR-0032）：主视觉是介绍、主要入口、站点统计和领奖台，下面是最新上传和“三步用上外置登录”。
 * 只读，服务端组件直接调用领域层的查询；统计和领奖台在领域层缓存 60 秒
 */
export default async function HomePage() {
  const [{ core }, user, root, t, common, format] = await Promise.all([
    getServer(),
    getSessionUser(),
    getRequestRoot(),
    getTranslations('home'),
    getTranslations('common'),
    getFormatter(),
  ])
  const [stats, podium, latest, settings] = await Promise.all([
    core.home.stats(),
    core.home.podium(),
    core.textures.list({ viewer: user?.uid ?? null, type: 'skin', sort: 'latest', page: 1, perPage: LATEST }),
    core.settings.read(['site.description', 'site.url', 'auth.registration.enabled']),
  ])
  const apiUrl = yggdrasilApiUrl(settings['site.url'], root)
  // 区间的两头是站点时区里的日期，按 UTC 的 0 点格式化，不会再被换算到前一天
  const day = (date: string) =>
    format.dateTime(new Date(`${date}T00:00:00Z`), { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
  const statItems = [
    { key: 'textures', value: stats.textures },
    { key: 'users', value: stats.users },
    { key: 'players', value: stats.players },
  ] as const

  return (
    <ToastProvider label={common('notifications')} closeLabel={common('close')}>
      <div className="flex min-h-dvh flex-col">
        <SiteHeader />
        <main className="flex-1">
          <section aria-labelledby="home-title" className="border-b border-border bg-surface">
            <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-10 sm:px-6 lg:grid-cols-2 lg:gap-12 lg:py-14">
              <div className="flex flex-col items-start gap-6">
                <p className="font-pixel text-pixel-1 text-text-muted">{t('eyebrow')}</p>
                <h1 id="home-title" className="font-pixel text-pixel-3 text-balance text-text sm:text-pixel-4">
                  {t('title')}
                </h1>
                <p className="max-w-prose text-base text-pretty text-text-muted">
                  {settings['site.description'].trim() || t('description')}
                </p>
                <div className="flex flex-wrap gap-3">
                  {user ? (
                    <>
                      <ButtonLink variant="primary" size="lg" render={<NextLink href="/skinlib/upload" />}>
                        <Upload aria-hidden />
                        {t('actions.upload')}
                      </ButtonLink>
                      <ButtonLink size="lg" render={<NextLink href="/user" />}>
                        {t('actions.userCenter')}
                      </ButtonLink>
                    </>
                  ) : (
                    <>
                      {settings['auth.registration.enabled'] ? (
                        <ButtonLink variant="primary" size="lg" render={<NextLink href="/sign-up" />}>
                          {t('actions.signUp')}
                        </ButtonLink>
                      ) : (
                        <ButtonLink variant="primary" size="lg" render={<NextLink href="/sign-in" />}>
                          {t('actions.signIn')}
                        </ButtonLink>
                      )}
                      <ButtonLink size="lg" render={<NextLink href="/skinlib" />}>
                        {t('actions.browse')}
                      </ButtonLink>
                    </>
                  )}
                </div>
                <dl aria-label={t('stats.label')} className="flex flex-wrap gap-x-10 gap-y-3">
                  {statItems.map((item) => (
                    <div key={item.key} className="flex flex-col-reverse">
                      <dt className="text-sm text-text-muted">{t(`stats.${item.key}`)}</dt>
                      <dd className="font-pixel text-pixel-2 text-text tabular-nums">{format.number(item.value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <HomePodium podium={podium} period={t('podium.period', { from: day(podium.from), to: day(podium.to) })} />
            </div>
          </section>

          <section
            aria-labelledby="latest-title"
            className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-12 sm:px-6"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <h2 id="latest-title" className="font-pixel text-pixel-2 text-text">
                {t('latest.title')}
              </h2>
              {latest.items.length > 0 && (
                <span className="text-sm">
                  <Link render={<NextLink href="/skinlib" />}>{t('latest.all')}</Link>
                </span>
              )}
            </div>
            {latest.items.length > 0 ? (
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
                {latest.items.map((texture) => (
                  <LibraryCard key={texture.tid} texture={texture} headingLevel="h3" />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<Image />}
                title={t('latest.emptyTitle')}
                description={t('latest.emptyDescription')}
                action={<Link render={<NextLink href="/skinlib/upload" />}>{t('latest.uploadFirst')}</Link>}
              />
            )}
          </section>

          <section aria-labelledby="launcher-title" className="border-t border-border bg-surface">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-12 sm:px-6">
              <div className="flex flex-col gap-1">
                <h2 id="launcher-title" className="font-pixel text-pixel-2 text-text">
                  {t('launcher.title')}
                </h2>
                <p className="max-w-prose text-sm text-pretty text-text-muted">{t('launcher.description')}</p>
              </div>
              <ol className="grid gap-4 lg:grid-cols-3">
                {STEPS.map((step, index) => (
                  <li key={step} className="flex flex-col gap-3 rounded-md border border-border bg-bg p-6">
                    <span aria-hidden className="font-pixel text-pixel-3 text-text-muted tabular-nums">
                      {index + 1}
                    </span>
                    <h3 className="text-lg font-medium text-text">{t(`launcher.steps.${step}.title`)}</h3>
                    <p className="text-sm text-pretty text-text-muted">{t(`launcher.steps.${step}.body`)}</p>
                    <div className="mt-auto flex min-w-0 flex-col items-start gap-3 pt-2 text-sm">
                      {step === 'player' &&
                        (user ? (
                          <Link render={<NextLink href="/user/players" />}>{t('launcher.steps.player.manage')}</Link>
                        ) : (
                          <Link render={<NextLink href="/sign-up" />}>{t('launcher.steps.player.signUp')}</Link>
                        ))}
                      {step === 'launcher' && (
                        <>
                          <code className="w-full rounded-sm border border-border bg-surface-sunken px-3 py-2 font-mono text-sm break-all text-text">
                            {apiUrl}
                          </code>
                          <LauncherCopyButton apiUrl={apiUrl} />
                        </>
                      )}
                      {step === 'wear' && (
                        <Link render={<NextLink href="/user/closet" />}>{t('launcher.steps.wear.closet')}</Link>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        </main>
        <SiteFooter />
      </div>
    </ToastProvider>
  )
}

/** 领奖台：最近 7 天新加进衣柜最多的三个皮肤，不满三个时空着（ADR-0032） */
async function HomePodium({ podium, period }: { podium: PodiumData; period: string }) {
  const [t, skinlib] = await Promise.all([getTranslations('home.podium'), getTranslations('skinlib')])
  return (
    <Podium
      title={t('title')}
      period={period}
      vacantLabel={t('vacant')}
      places={podium.entries.map((entry, index) => ({
        name: entry.name,
        figure: (
          <SkinFigure
            src={figureSrc(entry.hash, entry.type)}
            type={entry.type}
            textureScale={entry.scale}
            scale={5}
            alt={skinlib('figureAlt', { name: entry.name, type: skinlib(`types.${entry.type}`) })}
            loading="eager"
          />
        ),
        score: t('score', { gain: entry.gain }),
        label: t('label', { rank: index + 1, name: entry.name, gain: entry.gain }),
        render: <NextLink href={`/skinlib/${entry.tid}`} />,
      }))}
      empty={t.rich('empty', { link: (chunks) => <Link render={<NextLink href="/skinlib" />}>{chunks}</Link> })}
    />
  )
}
