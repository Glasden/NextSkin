import {
  can,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  outranks,
  type AdminClosetItem,
  type AdminUserDetail,
} from '@nextskin/domain'
import { matchLocale } from '@nextskin/i18n'
import { Alert, Badge, cx, FigurePlaceholder, Link, Pagination, PlayerHead, SkinFigure, Table } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getLocale, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { localeOptions } from '../../../../lib/locales'
import { pluginIcon, pluginName } from '../../../../lib/plugins'
import { scoreReasonText } from '../../../../lib/score-reason'
import { getServer } from '../../../../lib/server'
import { getRequestRoot, requireAdmin } from '../../../../lib/session'
import { figureSrc, headSrc } from '../../../../lib/textures'
import { AuditTable } from '../../audit-table'
import { ADMIN_PER_PAGE, auditHref, closetHref, parseClosetPage, parseId } from '../../params'
import { roleChanges, roleTones } from '../role-changes'
import { UserActions } from '../user-actions'
import { EmailDialog, NicknameDialog, VerifiedDialog } from './account-actions'
import { AddClosetItemDialog, RemoveClosetItemDialog } from './closet-actions'
import { DeleteUserDialog } from './delete-user-dialog'
import { ScoreDialog } from './score-dialog'
import {
  DeletePasskeysDialog,
  DisableTwoFactorDialog,
  RevokeSessionsDialog,
  SetPasswordDialog,
  UnlinkBindingDialog,
} from './security-actions'

export async function generateMetadata({ params }: { params: Promise<{ uid: string }> }): Promise<Metadata> {
  const [{ uid }, t] = await Promise.all([params, getTranslations('admin.userDetail')])
  return { title: t('metaTitle', { uid: parseId(uid) ?? uid }) }
}

/**
 * 一个用户（ADR-0036"页面"）：账号、积分、登录与安全、角色、材质、衣柜、审计和删除。要有 users.ban；
 * 改动要有 users.manage，并且只能对身份比自己低的人做。这里按权限决定显示哪些操作，防线在用例里（ADR-0027）
 */
export default async function AdminUserPage({
  params,
  searchParams,
}: {
  params: Promise<{ uid: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ uid: raw }, search] = await Promise.all([params, searchParams])
  const closetPage = parseClosetPage(search)
  const viewer = await requireAdmin(`/admin/users/${raw}`, 'users.ban')
  const uid = parseId(raw)
  if (uid === null) notFound()
  const { core } = await getServer()
  // 先过查询服务的权限检查，再读两步验证和第三方绑定
  const detail = await core.admin.userDetail(viewer.uid, uid)
  if (!detail) notFound()
  const root = await getRequestRoot()
  const [security, accounts, closet, mailConfigured, settings, t, admin, format, locale] = await Promise.all([
    core.auth.security(uid, root),
    core.externalLogin.accounts(uid),
    core.admin.listCloset(viewer.uid, uid, { page: closetPage, perPage: ADMIN_PER_PAGE }),
    core.mail.configured(),
    core.settings.read(['auth.requireEmailVerification', 'audit.retentionDays', 'score.refundOnDelete']),
    getTranslations('admin.userDetail'),
    getTranslations('admin'),
    getFormatter(),
    getLocale(),
  ])
  const { user, counts } = detail
  const self = viewer.uid === uid
  const manageable = !self && outranks(viewer.role, user.role)
  const canManage = manageable && can(viewer.role, 'users.manage')
  const changes = manageable ? roleChanges(user.role, can(viewer.role, 'users.appointAdmin')) : []
  const requireVerification = settings['auth.requireEmailVerification']
  const target = { uid, nickname: user.nickname, email: user.email }
  const dateTime = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
  const userLocale = user.locale ? matchLocale(user.locale) : null
  const bindings = accounts
    .filter((account) => account.linkedAt !== null)
    .map((account) => ({
      ...account,
      name: core.plugins.translate(account.pluginId, account.label, locale),
    }))

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <span className="text-sm">
          <Link render={<NextLink href="/admin/users" />}>{t('all')}</Link>
        </span>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <PlayerHead
              src={user.avatar ? headSrc(user.avatar.hash) : undefined}
              textureScale={user.avatar?.scale}
              size={48}
              alt=""
            />
            <div className="flex min-w-0 flex-col gap-2">
              <h1 className="font-pixel text-pixel-2 break-all text-text">{user.nickname}</h1>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={roleTones[user.role]}>{admin(`roles.${user.role}`)}</Badge>
                {self && <Badge>{admin('you')}</Badge>}
                <span className="font-mono text-xs text-text-muted">{t('uid', { uid })}</span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-4 text-sm">
            {can(viewer.role, 'notifications.send') && (
              <Link render={<NextLink href={`/admin/notifications?to=${uid}`} />}>{t('sendNotification')}</Link>
            )}
            <UserActions user={{ uid, nickname: user.nickname, role: user.role }} changes={changes} />
          </div>
        </div>
      </header>

      {!manageable && <Alert>{self ? t('selfHint') : t('outrankedHint')}</Alert>}

      <Section id="account" title={t('account.title')}>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Fact label={t('account.emailLabel')}>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 break-all">{user.email}</span>
              {user.emailVerified ? (
                <Badge tone="success">{t('account.verified')}</Badge>
              ) : (
                <Badge tone="warning">{t('account.unverified')}</Badge>
              )}
            </span>
          </Fact>
          <Fact label={t('account.nicknameLabel')}>
            <span className="break-all">{user.nickname}</span>
          </Fact>
          <Fact label={t('account.registeredAt')}>
            <time dateTime={user.registeredAt}>{dateTime(user.registeredAt)}</time>
          </Fact>
          <Fact label={t('account.locale')}>
            {userLocale ? (
              (localeOptions.find((option) => option.value === userLocale)?.label ?? userLocale)
            ) : (
              <span className="text-text-muted">{t('account.localeUnset')}</span>
            )}
          </Fact>
        </dl>
        {canManage && (
          <Actions>
            <NicknameDialog user={target} />
            <EmailDialog user={target} mailConfigured={mailConfigured} requireVerification={requireVerification} />
            <VerifiedDialog user={target} verified={user.emailVerified} requireVerification={requireVerification} />
          </Actions>
        )}
      </Section>

      <Section id="score" title={t('score.title')}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col">
            <span className="text-sm text-text-muted">{t('score.balance')}</span>
            <span className="font-pixel text-pixel-2 text-text tabular-nums">{format.number(user.score)}</span>
          </div>
          {canManage && <ScoreDialog uid={uid} nickname={user.nickname} score={user.score} />}
        </div>
        <ScoreHistory entries={detail.recentScore} dateTime={dateTime} />
      </Section>

      <Section id="security" title={t('security.title')} description={t('security.description')}>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label={t('security.passwordLabel')}>
            {detail.hasPassword ? (
              <Badge tone="success">{t('security.passwordSet')}</Badge>
            ) : (
              <Badge tone="warning">{t('security.passwordNotSet')}</Badge>
            )}
          </Fact>
          <Fact label={t('security.twoFactorLabel')}>
            {user.twoFactorEnabled ? (
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone="success">{t('security.on')}</Badge>
                {security.backupCodesRemaining !== null && (
                  <span className="text-sm text-text-muted">
                    {t('security.backupCodes', { count: security.backupCodesRemaining })}
                  </span>
                )}
              </span>
            ) : (
              <Badge>{t('security.off')}</Badge>
            )}
          </Fact>
          <Fact label={t('security.passkeysLabel')}>
            <Count value={counts.passkeys}>{t('security.passkeys', { count: counts.passkeys })}</Count>
          </Fact>
          <Fact label={t('security.sessionsLabel')}>
            <Count value={counts.sessions}>{t('security.sessions', { count: counts.sessions })}</Count>
          </Fact>
          <Fact label={t('security.launcherLabel')}>
            <Count value={counts.launcherTokens}>{t('security.launcher', { count: counts.launcherTokens })}</Count>
          </Fact>
          <Fact label={t('security.authorizedAppsLabel')}>
            <Count value={counts.authorizedApps}>
              {t('security.authorizedApps', { count: counts.authorizedApps })}
            </Count>
          </Fact>
          <Fact label={t('security.bindingsLabel')}>
            <Count value={bindings.length}>{t('security.bindings', { count: bindings.length })}</Count>
          </Fact>
        </dl>
        {bindings.length > 0 && (
          <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
            {bindings.map((binding) => (
              <li
                key={`${binding.pluginId}:${binding.providerId}`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="shrink-0 text-text-muted">{pluginIcon(binding.icon, { 'aria-hidden': true })}</span>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex flex-wrap items-center gap-2 text-sm text-text">
                      {binding.name}
                      {!binding.available && <Badge tone="warning">{t('security.unavailable')}</Badge>}
                    </span>
                    {binding.linkedAt && (
                      <span className="text-xs text-text-muted">
                        {t('security.linkedAt', { time: dateTime(binding.linkedAt) })}
                      </span>
                    )}
                  </span>
                </span>
                {canManage && (
                  <UnlinkBindingDialog
                    uid={uid}
                    nickname={user.nickname}
                    pluginId={binding.pluginId}
                    providerId={binding.providerId}
                    name={binding.name}
                    available={binding.available}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <Actions>
            <SetPasswordDialog
              uid={uid}
              nickname={user.nickname}
              min={MIN_PASSWORD_LENGTH}
              max={MAX_PASSWORD_LENGTH}
              passkeys={counts.passkeys}
              bindings={bindings.map((binding) => binding.name)}
              sessions={counts.sessions}
              launcherTokens={counts.launcherTokens}
            />
            {user.twoFactorEnabled && <DisableTwoFactorDialog uid={uid} nickname={user.nickname} />}
            {counts.passkeys > 0 && <DeletePasskeysDialog uid={uid} nickname={user.nickname} count={counts.passkeys} />}
            <RevokeSessionsDialog
              uid={uid}
              nickname={user.nickname}
              sessions={counts.sessions}
              launcherTokens={counts.launcherTokens}
              passkeys={counts.passkeys}
              bindings={bindings.length}
            />
          </Actions>
        )}
      </Section>

      <Section
        id="players"
        title={t('players.title')}
        badge={<Badge>{t('players.count', { count: counts.players })}</Badge>}
      >
        <PlayerList players={detail.players} total={counts.players} />
        {counts.players > 0 && can(viewer.role, 'players.manage') && (
          <span className="text-sm">
            <Link render={<NextLink href={`/admin/players?owner=${uid}`} />}>{t('players.manage')}</Link>
          </span>
        )}
      </Section>

      <Section id="textures" title={t('textures.title')}>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Fact label={t('textures.public')}>
            <span className="tabular-nums">{format.number(counts.publicTextures)}</span>
          </Fact>
          <Fact label={t('textures.private')}>
            <span className="tabular-nums">{format.number(counts.privateTextures)}</span>
          </Fact>
        </dl>
        {counts.publicTextures + counts.privateTextures > 0 && (
          <span className="text-sm">
            <Link render={<NextLink href={`/skinlib?uploader=${uid}`} />}>{t('textures.browse')}</Link>
          </span>
        )}
      </Section>

      <Section id="oauth-clients" title={t('oauthClients.title')}>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Fact label={t('oauthClients.owned')}>
            <span className="tabular-nums">{format.number(counts.oauthClients)}</span>
          </Fact>
        </dl>
        {counts.oauthClients > 0 && can(viewer.role, 'oauthClients.manage') && (
          <span className="text-sm">
            <Link render={<NextLink href={`/admin/oauth-clients?owner=${uid}`} />}>{t('oauthClients.manage')}</Link>
          </span>
        )}
      </Section>

      <Section
        id="closet"
        title={t('closet.title')}
        badge={<Badge>{t('closet.count', { count: closet.total })}</Badge>}
        description={t('closet.description')}
      >
        <ClosetList
          uid={uid}
          items={closet.items}
          canManage={canManage}
          refund={settings['score.refundOnDelete']}
          dateTime={dateTime}
        />
        <Pagination
          page={closetPage}
          pageCount={Math.ceil(closet.total / ADMIN_PER_PAGE)}
          href={(page) => closetHref(uid, page)}
          linkAs={NextLink}
          label={t('closet.pagination')}
          previousLabel={admin('previous')}
          nextLabel={admin('next')}
          pageLabel={(page) => admin('page', { page })}
        />
        {canManage && (
          <Actions>
            <AddClosetItemDialog uid={uid} nickname={user.nickname} />
          </Actions>
        )}
      </Section>

      <section aria-labelledby="audit-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="audit-heading" className="font-pixel text-pixel-1 text-text">
            {t('audit.title')}
          </h2>
          {can(viewer.role, 'audit.read') && (
            <span className="flex flex-wrap gap-x-4 text-sm">
              <Link
                render={<NextLink href={auditHref({ subject: { type: 'user', id: uid }, actor: null, page: 1 })} />}
              >
                {t('audit.allAbout')}
              </Link>
              <Link render={<NextLink href={auditHref({ subject: null, actor: uid, page: 1 })} />}>
                {t('audit.allBy')}
              </Link>
            </span>
          )}
        </div>
        <AuditTable entries={detail.recentAudit} label={t('audit.tableLabel')} empty={t('audit.empty')} />
      </section>

      {canManage && (
        <Section id="delete" title={t('delete.title')} description={t('delete.description')}>
          <div>
            <DeleteUserDialog
              uid={uid}
              nickname={user.nickname}
              banned={user.role === 'banned'}
              score={user.score}
              players={counts.players}
              privateTextures={counts.privateTextures}
              publicTextures={counts.publicTextures}
              closetItems={counts.closetItems}
              oauthClients={counts.oauthClients}
              canDeleteTextures={can(viewer.role, 'textures.manage')}
              retentionDays={settings['audit.retentionDays']}
            />
          </div>
        </Section>
      )}
    </div>
  )
}

/** 最近 10 条积分流水，写法同用户中心的仪表盘 */
async function ScoreHistory({
  entries,
  dateTime,
}: {
  entries: AdminUserDetail['recentScore']
  dateTime: (iso: string) => string
}) {
  const [t, reasonOf, format, { core }, locale] = await Promise.all([
    getTranslations('admin.userDetail.score'),
    scoreReasonText(),
    getFormatter(),
    getServer(),
    getLocale(),
  ])
  if (!entries.length) return <p className="text-sm text-text-muted">{t('empty')}</p>
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm text-text-muted">{t('recent')}</h3>
      <ol className="divide-y divide-border rounded-sm border border-border">
        {entries.map((entry) => {
          // 插件写的流水标出是哪个插件（ADR-0041）；插件已经卸载时只剩 id
          const plugin =
            entry.pluginId === null
              ? null
              : core.plugins.get(entry.pluginId)
                ? pluginName(core, entry.pluginId, locale)
                : entry.pluginId
          return (
            <li key={entry.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-text">{reasonOf(entry)}</span>
                <span className="text-xs text-text-muted">
                  <time dateTime={entry.createdAt}>{dateTime(entry.createdAt)}</time>
                  {plugin !== null && ` · ${t('viaPlugin', { name: plugin })}`}
                </span>
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <span
                  className={cx('text-sm font-medium tabular-nums', entry.delta > 0 ? 'text-success' : 'text-text')}
                >
                  {`${entry.delta > 0 ? '+' : ''}${format.number(entry.delta)}`}
                </span>
                <span className="text-xs text-text-muted tabular-nums">
                  {t('balanceAfter', { balance: format.number(entry.balance) })}
                </span>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** 名下的角色，最多列出 100 个 */
async function PlayerList({ players, total }: { players: AdminUserDetail['players']; total: number }) {
  const t = await getTranslations('admin.userDetail.players')
  return (
    <div className="flex flex-col gap-3">
      <Table<'name' | 'uuid'>
        label={t('tableLabel')}
        empty={t('empty')}
        columns={[
          { key: 'name', header: t('name') },
          { key: 'uuid', header: t('uuid') },
        ]}
        rows={players.map((player) => ({
          key: player.pid,
          cells: {
            name: <span className="break-all">{player.name}</span>,
            uuid: <span className="font-mono text-xs break-all select-all">{player.uuid}</span>,
          },
        }))}
      />
      {total > players.length && (
        <p className="text-sm text-text-muted">{t('truncated', { shown: players.length, total })}</p>
      )}
    </div>
  )
}

/**
 * 衣柜里的材质，包括主人看不见的导入遗留项（别人上传的私有材质），标出来；它们也能移出（ADR-0036"衣柜"）。
 * 别人的私有材质在没有 textures.manage 时查询服务不给名字和预览，只写"私有材质"和编号
 */
async function ClosetList({
  uid,
  items,
  canManage,
  refund,
  dateTime,
}: {
  uid: number
  items: AdminClosetItem[]
  canManage: boolean
  refund: boolean
  dateTime: (iso: string) => string
}) {
  const [t, skinlib, format] = await Promise.all([
    getTranslations('admin.userDetail.closet'),
    getTranslations('skinlib'),
    getFormatter(),
  ])
  return (
    <Table<'texture' | 'name' | 'scorePaid' | 'addedAt' | 'actions'>
      label={t('tableLabel')}
      empty={t('empty')}
      columns={[
        { key: 'texture', header: t('columns.texture'), shrink: true },
        { key: 'name', header: t('columns.name') },
        { key: 'scorePaid', header: t('columns.scorePaid'), align: 'end', shrink: true },
        { key: 'addedAt', header: t('columns.addedAt'), shrink: true },
        ...(canManage ? [{ key: 'actions' as const, header: t('columns.actions'), shrink: true }] : []),
      ]}
      rows={items.map((item) => {
        const texture = item.texture
        // 别人的私有材质在没有 textures.manage 时连衣柜名也不给（默认就是材质名），只写"私有材质"和编号
        const name = item.name ?? t('hidden', { tid: item.tid })
        return {
          key: item.tid,
          cells: {
            texture: (
              <span className="grid h-28 w-16 shrink-0 place-items-center rounded-sm bg-stage">
                {texture ? (
                  <SkinFigure
                    src={figureSrc(texture.hash, texture.type)}
                    type={texture.type}
                    textureScale={texture.scale}
                    scale={3}
                    view="front"
                    alt={skinlib('figureAlt', { name: texture.name, type: skinlib(`types.${texture.type}`) })}
                  />
                ) : (
                  <FigurePlaceholder scale={3} view="front" label={t('hidden', { tid: item.tid })} />
                )}
              </span>
            ),
            name: (
              <span className="flex min-w-48 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 font-medium break-all">{name}</span>
                  {texture && <Badge>{skinlib(`types.${texture.type}`)}</Badge>}
                  {texture && !texture.public && <Badge>{skinlib('private')}</Badge>}
                  {!item.visibleToOwner && <Badge tone="warning">{t('invisible')}</Badge>}
                </span>
                {texture && (
                  <span className="text-sm text-text-muted">
                    <Link render={<NextLink href={`/skinlib/${item.tid}`} />}>
                      {t('texture', { tid: item.tid, name: texture.name })}
                    </Link>
                  </span>
                )}
              </span>
            ),
            scorePaid: <span className="tabular-nums">{format.number(item.scorePaid)}</span>,
            addedAt: <time dateTime={item.addedAt}>{dateTime(item.addedAt)}</time>,
            actions: canManage ? (
              <RemoveClosetItemDialog
                uid={uid}
                item={{ tid: item.tid, name, scorePaid: item.scorePaid }}
                refund={refund}
              />
            ) : null,
          },
        }
      })}
    />
  )
}

/** 数量为 0 时用弱化的颜色 */
function Count({ value, children }: { value: number; children: ReactNode }) {
  return <span className={cx('tabular-nums', value === 0 && 'text-text-muted')}>{children}</span>
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="min-w-0 text-base text-text">{children}</dd>
    </div>
  )
}

/** 一节的操作按钮，排在卡片底部 */
function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2 border-t border-border pt-4">{children}</div>
}

/** 一节：标题在卡片外面，同用户中心的设置页 */
function Section({
  id,
  title,
  badge,
  description,
  children,
}: {
  id: string
  title: string
  badge?: ReactNode
  description?: string
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 id={`${id}-heading`} className="font-pixel text-pixel-1 text-text">
          {title}
        </h2>
        {badge}
      </div>
      <div className="flex flex-col gap-4 rounded-md border border-border bg-surface p-6">
        {description && <p className="max-w-prose text-sm text-pretty text-text-muted">{description}</p>}
        {children}
      </div>
    </section>
  )
}
