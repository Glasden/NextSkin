import type { OwnedPlayer, ScoreEntry } from '@nextskin/domain'
import { Alert, cx, FigurePlaceholder, Link, Markdown, NameTag, SkinFigure, Stage } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { getServer } from '../../lib/server'
import { scoreReasonText } from '../../lib/score-reason'
import { getRequestRoot, requireUser } from '../../lib/session'
import { figureSrc } from '../../lib/textures'
import { yggdrasilApiUrl } from '../../lib/yggdrasil'
import { CheckInButton } from './check-in-button'
import { LauncherCopyButton } from './launcher-copy-button'
import { VerifyEmailAlert } from './verify-email-alert'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('user.dashboard')
  return { title: t('title') }
}

// 展台上最多站几个角色：窄屏放三个，再宽一些放四个，其余的在旁边写个数
const LINEUP = 4
const LAUNCHER_STEPS = ['add', 'login', 'twoFactor'] as const

export default async function DashboardPage() {
  const user = await requireUser('/user')
  const { core } = await getServer()
  const [overview, players, history, settings, mailConfigured, hasPassword, root, t, format, reasonOf] =
    await Promise.all([
      core.users.overview(user.uid),
      core.players.listOwned(user.uid),
      core.score.recent(user.uid),
      core.settings.read([
        'checkIn.score',
        'score.perPlayer',
        'auth.requireEmailVerification',
        'site.announcement',
        'site.url',
      ]),
      core.mail.configured(),
      core.externalLogin.hasPassword(user.uid),
      getRequestRoot(),
      getTranslations('user.dashboard'),
      getFormatter(),
      scoreReasonText(),
    ])
  // 会话还在、用户已经被删掉的极少数情况
  if (!overview) redirect('/sign-in')
  const { min, max } = settings['checkIn.score']
  const dateTime = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
  const apiUrl = yggdrasilApiUrl(settings['site.url'], root)

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="text-sm text-text-muted">{t('greeting', { nickname: overview.nickname })}</p>
      </header>
      {settings['auth.requireEmailVerification'] && !overview.emailVerified && (
        <VerifyEmailAlert email={overview.email} mailConfigured={mailConfigured} />
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <section aria-labelledby="lineup-heading" className="flex flex-col gap-3 lg:col-span-2">
          <div className="flex items-center justify-between gap-4">
            <h2 id="lineup-heading" className="font-pixel text-pixel-1 text-text">
              {t('players')}
            </h2>
            <span className="text-sm">
              <Link render={<NextLink href="/user/players" />}>{t('managePlayers')}</Link>
            </span>
          </div>
          <div className="h-64">
            <Stage grid>
              <Lineup players={players} more={(count) => t('morePlayers', { count })} empty={t('noPlayers')} />
            </Stage>
          </div>
        </section>
        <section aria-labelledby="score-heading" className="flex flex-col gap-3">
          <h2 id="score-heading" className="font-pixel text-pixel-1 text-text">
            {t('score')}
          </h2>
          <div className="flex flex-1 flex-col justify-between gap-6 rounded-md border border-border bg-surface p-6">
            <div className="flex flex-col gap-2">
              <p className="font-pixel text-pixel-3 text-text tabular-nums">{format.number(overview.score)}</p>
              <p className="text-sm text-text-muted">{t('scoreUsage', { cost: settings['score.perPlayer'] })}</p>
            </div>
            <div className="flex flex-col gap-3">
              <CheckInButton available={overview.nextCheckInAt === null} />
              <p className="text-sm text-pretty text-text-muted">
                {overview.nextCheckInAt
                  ? t('nextCheckIn', { time: dateTime(overview.nextCheckInAt) })
                  : t('checkInHint', { same: String(min === max), min, max })}
              </p>
            </div>
          </div>
        </section>
      </div>
      {/* 管理员在后台写的公告（ADR-0028），空的时候不显示 */}
      {settings['site.announcement'].trim() && (
        <section aria-labelledby="announcement-heading" className="flex flex-col gap-3">
          <h2 id="announcement-heading" className="font-pixel text-pixel-1 text-text">
            {t('announcement')}
          </h2>
          <div className="rounded-md border border-border bg-surface p-6">
            <Markdown>{settings['site.announcement']}</Markdown>
          </div>
        </section>
      )}
      {/* 外置登录的快速配置（BS 的 ygg_show_config_section），总是显示（ADR-0030） */}
      <section id="launcher" aria-labelledby="launcher-heading" className="flex flex-col gap-3">
        <h2 id="launcher-heading" className="font-pixel text-pixel-1 text-text">
          {t('launcher.title')}
        </h2>
        <div className="flex flex-col gap-6 rounded-md border border-border bg-surface p-6">
          <div className="flex flex-col gap-3">
            <p className="max-w-prose text-sm text-pretty text-text-muted">{t('launcher.description')}</p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 rounded-sm border border-border bg-surface-sunken px-3 py-2 font-mono text-sm break-all text-text">
                {apiUrl}
              </code>
              <LauncherCopyButton apiUrl={apiUrl} />
            </div>
            <p className="text-xs text-pretty text-text-muted">{t('launcher.dragHint')}</p>
          </div>
          {/* 启动器登录只认密码：经第三方登录注册的账号要先设置密码（ADR-0034） */}
          {!hasPassword && (
            <Alert tone="warning">
              {t.rich('launcher.passwordRequired', {
                link: (chunks) => <Link render={<NextLink href="/user/security#password" />}>{chunks}</Link>,
              })}
            </Alert>
          )}
          <ol className="grid gap-6 border-t border-border pt-6 sm:grid-cols-3">
            {LAUNCHER_STEPS.map((step, index) => (
              <li key={step} className="flex gap-4 sm:flex-col sm:gap-2">
                <span aria-hidden className="w-6 shrink-0 font-pixel text-pixel-3 text-text-muted tabular-nums">
                  {index + 1}
                </span>
                <div className="flex flex-col gap-1">
                  <h3 className="text-base font-medium text-text">{t(`launcher.steps.${step}.title`)}</h3>
                  <p className="text-sm text-pretty text-text-muted">{t(`launcher.steps.${step}.body`)}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
      <section aria-labelledby="history-heading" className="flex flex-col gap-3">
        <h2 id="history-heading" className="font-pixel text-pixel-1 text-text">
          {t('history')}
        </h2>
        {history.length ? (
          <ol className="divide-y divide-border rounded-md border border-border bg-surface">
            {history.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                reason={reasonOf(entry)}
                time={dateTime(entry.createdAt)}
                delta={`${entry.delta > 0 ? '+' : ''}${format.number(entry.delta)}`}
                balance={t('balance', { balance: format.number(entry.balance) })}
              />
            ))}
          </ol>
        ) : (
          <p className="rounded-md border border-dashed border-border-strong px-4 py-6 text-sm text-text-muted">
            {t('noHistory')}
          </p>
        )}
      </section>
    </div>
  )
}

/** 展台上一排角色，头顶是名牌（DESIGN.md §2.2）。只放正面，鼠标移上去时抬手；还没有皮肤的用剪影代替 */
async function Lineup({
  players,
  more,
  empty,
}: {
  players: OwnedPlayer[]
  more: (count: number) => string
  empty: string
}) {
  const t = await getTranslations('user.players')
  if (!players.length) return <p className="max-w-xs px-4 text-center text-sm text-text-muted">{empty}</p>
  const rest = players.length - LINEUP
  return (
    <div className="flex items-end gap-4 sm:gap-8">
      {players.slice(0, LINEUP).map((player, index) => (
        <div
          key={player.pid}
          className={cx('flex w-20 flex-col items-center gap-3', index === LINEUP - 1 && 'max-sm:hidden')}
        >
          <NameTag>{player.name}</NameTag>
          {player.skin ? (
            <SkinFigure
              src={figureSrc(player.skin.hash, player.skin.type)}
              type={player.skin.type}
              textureScale={player.skin.scale}
              scale={4}
              view="front"
              alt={t('figure', { name: player.name })}
              raiseOnHover
              loading="eager"
            />
          ) : (
            <FigurePlaceholder scale={4} view="front" label={t('figureEmpty', { name: player.name })} />
          )}
        </div>
      ))}
      {rest > 0 && <p className="self-center text-sm text-text-muted">{more(rest)}</p>}
    </div>
  )
}

/** reason 已经翻译好（`lib/score-reason.ts`：核心的原因和插件写的原因） */
function HistoryRow({
  entry,
  reason,
  time,
  delta,
  balance,
}: {
  entry: ScoreEntry
  reason: string
  time: string
  delta: string
  balance: string
}) {
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-text">{reason}</span>
        <time dateTime={entry.createdAt} className="text-xs text-text-muted">
          {time}
        </time>
      </div>
      <div className="flex shrink-0 flex-col items-end">
        <span className={cx('text-sm font-medium tabular-nums', entry.delta > 0 ? 'text-success' : 'text-text')}>
          {delta}
        </span>
        <span className="text-xs text-text-muted tabular-nums">{balance}</span>
      </div>
    </li>
  )
}
