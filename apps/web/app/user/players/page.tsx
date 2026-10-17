import { Alert, EmptyState, FigurePlaceholder, PlayerCard } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { Users } from 'pixelarticons/react/Users.js'
import { getServer } from '../../../lib/server'
import { requireUser } from '../../../lib/session'
import { AddPlayerDialog } from './add-player-dialog'
import { CopyUuidButton } from './copy-uuid-button'
import { DeletePlayerDialog, RenamePlayerDialog } from './player-dialogs'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('user.players')
  return { title: t('title') }
}

/**
 * 带连字符的 UUID。库里和 Yggdrasil 接口用的是 32 位不带连字符的写法；服主在 whitelist.json、游戏指令里
 * 用的是带连字符的写法
 */
const hyphenated = (uuid: string) => uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')

export default async function PlayersPage() {
  const user = await requireUser('/user/players')
  const { core } = await getServer()
  const [overview, players, settings, t, format] = await Promise.all([
    core.users.overview(user.uid),
    core.players.listOwned(user.uid),
    core.settings.read([
      'player.nameRule',
      'player.nameLength',
      'score.perPlayer',
      'score.refundOnDelete',
      'auth.requireEmailVerification',
    ]),
    getTranslations('user.players'),
    getFormatter(),
  ])
  const common = await getTranslations('common')
  if (!overview) redirect('/sign-in')
  // 写操作由用例检查（ADR-0022）；这里只是不让用户点了才知道不行
  const locked = settings['auth.requireEmailVerification'] && !overview.emailVerified
  const cost = settings['score.perPlayer']
  const refund = settings['score.refundOnDelete']
  const nameRule = { rule: settings['player.nameRule'], ...settings['player.nameLength'] }
  const add = <AddPlayerDialog cost={cost} score={overview.score} nameRule={nameRule} disabled={locked} />

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-baseline gap-3 font-pixel text-pixel-2 text-text">
            {t('title')}
            {players.length > 0 && (
              <span className="text-pixel-1 text-text-muted tabular-nums">{t('count', { count: players.length })}</span>
            )}
          </h1>
          <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
          <p className="text-sm text-pretty text-text-muted">
            {common('sentences', {
              first: cost > 0 ? t('cost', { cost, score: overview.score }) : t('free'),
              second: t('refundPolicy', { refund: String(refund && cost > 0) }),
            })}
          </p>
        </div>
        {players.length > 0 && <div className="shrink-0">{add}</div>}
      </header>
      {locked && <Alert tone="warning">{t('verifyFirst')}</Alert>}
      {players.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {players.map((player) => (
            <PlayerCard
              key={player.pid}
              name={player.name}
              figure={
                <FigurePlaceholder
                  scale={4}
                  label={player.skin ? t('figure', { name: player.name }) : t('figureEmpty', { name: player.name })}
                />
              }
              actions={
                <>
                  <RenamePlayerDialog pid={player.pid} name={player.name} nameRule={nameRule} disabled={locked} />
                  <DeletePlayerDialog
                    pid={player.pid}
                    name={player.name}
                    refund={refund ? player.scorePaid : 0}
                    disabled={locked}
                  />
                </>
              }
            >
              <div className="flex min-w-0 items-start gap-1">
                <code className="min-w-0 pt-2 font-mono text-xs break-all text-text">{hyphenated(player.uuid)}</code>
                <CopyUuidButton uuid={hyphenated(player.uuid)} name={player.name} />
              </div>
              <p>
                {t('updatedAt', {
                  time: format.dateTime(new Date(player.updatedAt), { dateStyle: 'medium', timeStyle: 'short' }),
                })}
              </p>
              <p>
                {player.skin || player.cape
                  ? [player.skin && t('hasSkin'), player.cape && t('hasCape')].filter(Boolean).join(' · ')
                  : t('noSkin')}
              </p>
            </PlayerCard>
          ))}
        </div>
      ) : (
        <EmptyState icon={<Users />} title={t('emptyTitle')} description={t('emptyDescription')} action={add} />
      )}
    </div>
  )
}
