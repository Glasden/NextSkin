import type { OwnedPlayer, ScoreEntry } from '@nextskin/domain'
import { cx, FigurePlaceholder, Link, NameTag, Stage } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { getServer } from '../../lib/server'
import { requireUser } from '../../lib/session'
import { CheckInButton } from './check-in-button'
import { VerifyEmailAlert } from './verify-email-alert'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('user.dashboard')
  return { title: t('title') }
}

// 展台上最多站几个角色：窄屏放三个，再宽一些放四个，其余的在旁边写个数
const LINEUP = 4

export default async function DashboardPage() {
  const user = await requireUser('/user')
  const { core } = await getServer()
  const [overview, players, history, settings, mailConfigured, t, format] = await Promise.all([
    core.users.overview(user.uid),
    core.players.listOwned(user.uid),
    core.score.recent(user.uid),
    core.settings.read(['checkIn.score', 'score.perPlayer', 'auth.requireEmailVerification']),
    core.mail.configured(),
    getTranslations('user.dashboard'),
    getFormatter(),
  ])
  // 会话还在、用户已经被删掉的极少数情况
  if (!overview) redirect('/sign-in')
  const { min, max } = settings['checkIn.score']
  const dateTime = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })

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

/** 展台上一排角色，头顶是名牌（DESIGN.md §2.2）。出图接口落地之前，皮肤一律先用剪影代替（ADR-0022） */
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
          <FigurePlaceholder
            scale={4}
            label={player.skin ? t('figure', { name: player.name }) : t('figureEmpty', { name: player.name })}
          />
        </div>
      ))}
      {rest > 0 && <p className="self-center text-sm text-text-muted">{more(rest)}</p>}
    </div>
  )
}

async function HistoryRow({
  entry,
  time,
  delta,
  balance,
}: {
  entry: ScoreEntry
  time: string
  delta: string
  balance: string
}) {
  const reasons = await getTranslations('score.reasons')
  // 原因存的是文案键（score.reasons.*）；插件写的原因以后在插件自己的命名空间里，翻译不了时原样显示
  const key = entry.reason.replace(/^score\.reasons\./, '')
  const reason = reasons.has(key as 'initial') ? reasons(key as 'initial') : entry.reason
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
