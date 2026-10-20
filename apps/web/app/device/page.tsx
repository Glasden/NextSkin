import { DomainError, JOIN_SCOPE, READ_SCOPE, SELECT_SCOPE } from '@nextskin/domain'
import { Alert, Button, Field, Input } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import { AvatarSquare } from 'pixelarticons/react/AvatarSquare.js'
import { Gamepad } from 'pixelarticons/react/Gamepad.js'
import { Human } from 'pixelarticons/react/Human.js'
import { Mail } from 'pixelarticons/react/Mail.js'
import { Monitor } from 'pixelarticons/react/Monitor.js'
import { Refresh } from 'pixelarticons/react/Refresh.js'
import { User } from 'pixelarticons/react/User.js'
import { Users } from 'pixelarticons/react/Users.js'
import type { ComponentType, ReactNode, SVGProps } from 'react'
import { clientLabel, describeScopes } from '../../lib/oauth'
import { getServer } from '../../lib/server'
import { requireUser } from '../../lib/session'
import { AuthHeading } from '../(auth)/auth-heading'
import { AuthShell, DefaultIllustration } from '../(auth)/auth-shell'
import { VerifyEmailAlert } from '../user/verify-email-alert'
import { DeviceRequest } from './device-request'
import { DeviceResult } from './device-result'
import { DeviceSelectionProvider, DeviceStage, type DevicePlayer } from './device-selection'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('device')
  return { title: t('title') }
}

const SCOPE_ICONS: Readonly<Record<string, ComponentType<SVGProps<SVGSVGElement>>>> = {
  openid: User,
  profile: AvatarSquare,
  email: Mail,
  offline_access: Refresh,
  [SELECT_SCOPE]: Human,
  [READ_SCOPE]: Users,
  [JOIN_SCOPE]: Gamepad,
}

/** 用户代码是 Better Auth 生成的 8 位，中间加一道连字符好核对；不是 8 位的原样显示 */
function formatUserCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
}

/**
 * 设备码流程的批准页（ADR-0037"页面"）：启动器给出代码和这个地址，用户在浏览器里登录、核对、选角色、授权。
 * 打开就认领（ADR-0007）：之后只有这个账号能批准或拒绝。认领、批准、拒绝都经领域用例，不走 Better Auth 的端点。
 * 不放进 (auth) 分组：展台上换成所选的角色
 */
export default async function DevicePage({ searchParams }: PageProps<'/device'>) {
  const query = await searchParams
  const input = typeof query.user_code === 'string' ? query.user_code.trim().slice(0, 64) : ''
  const user = await requireUser(input ? `/device?user_code=${encodeURIComponent(input)}` : '/device')
  const [{ core }, t] = await Promise.all([getServer(), getTranslations('device')])

  const heading = <AuthHeading title={t('title')}>{t('enterDescription')}</AuthHeading>
  if (!input)
    return (
      <AuthShell>
        {heading}
        <CodeForm />
      </AuthShell>
    )

  // 猜错代码太多次时领域用例抛 too_many_requests（按用户计数）
  const view = await core.oauth.openDevice(user.uid, input).catch((error: unknown) => {
    if (error instanceof DomainError && error.code === 'too_many_requests')
      return { status: 'throttled' as const, retryAfter: Number(error.params?.retryAfter ?? 60) }
    throw error
  })
  if (view.status === 'throttled')
    return (
      <AuthShell>
        <AuthHeading title={t('title')} />
        <Alert tone="danger">{t('tooManyAttempts', { minutes: Math.max(1, Math.ceil(view.retryAfter / 60)) })}</Alert>
      </AuthShell>
    )

  if (view.status === 'invalid' || view.status === 'expired' || view.status === 'claimed')
    return (
      <AuthShell>
        {heading}
        <div className="flex flex-col gap-6">
          <Alert tone={view.status === 'invalid' ? 'danger' : 'warning'}>{t(view.status)}</Alert>
          <CodeForm defaultValue={view.status === 'invalid' ? input : undefined} />
        </div>
      </AuthShell>
    )

  const settings = await core.settings.read(['site.name', 'auth.requireEmailVerification'])
  const client = await clientLabel(view.client, settings['site.name'])
  // 本人已经处理过、启动器还没来兑换
  if (view.status !== 'pending')
    return (
      <AuthShell>
        <DeviceResult status={view.status} clientName={client.name} />
      </AuthShell>
    )

  const choosePlayer = view.scopes.includes(SELECT_SCOPE)
  const [owned, overview, mailConfigured, scopes, format] = await Promise.all([
    choosePlayer ? core.players.listOwned(user.uid) : Promise.resolve([]),
    core.users.overview(user.uid),
    core.mail.configured(),
    describeScopes(view.scopes),
    getFormatter(),
  ])
  const players: DevicePlayer[] = owned.map((player) => ({
    pid: player.pid,
    name: player.name,
    skin: player.skin && { hash: player.skin.hash, type: player.skin.type, scale: player.skin.scale },
  }))
  // 申请 Select 时必须选角色；只有一个角色时默认选中，仍要用户点"授权"（ADR-0037"角色绑定"）
  const initial = players.length === 1 ? players[0]!.pid : null
  const unverified = settings['auth.requireEmailVerification'] && overview !== null && !overview.emailVerified
  const blocked =
    user.role === 'banned' ? (
      <Alert tone="danger">{t('banned')}</Alert>
    ) : unverified ? (
      <VerifyEmailAlert email={overview.email} mailConfigured={mailConfigured} />
    ) : null
  const illustration = (scale: 4 | 8) => (
    <DeviceStage players={players} scale={scale} fallback={<DefaultIllustration scale={scale} />} />
  )

  return (
    <DeviceSelectionProvider initial={initial}>
      <AuthShell illustration={illustration}>
        <DeviceRequest
          userCode={view.userCode}
          clientName={client.name}
          players={players}
          choosePlayer={choosePlayer}
          blocked={blocked}
        >
          <AuthHeading title={t('requestTitle')} />
          <div className="-mt-2 flex flex-col overflow-hidden rounded-md border border-border bg-surface">
            <div className="flex items-center gap-3 p-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-surface-sunken text-text-muted">
                <Monitor aria-hidden />
              </span>
              <div className="flex min-w-0 flex-col">
                {/* 应用名是创建者填的，用正文字体（DESIGN.md §4） */}
                <span className="truncate text-lg font-medium text-text">{client.name}</span>
                <span className="text-sm text-pretty text-text-muted">{client.byline}</span>
              </div>
            </div>
            <dl className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-t border-border bg-surface-sunken px-4 py-3">
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-text-muted">{t('codeLabel')}</dt>
                <dd className="font-mono text-xl tracking-widest text-text">{formatUserCode(view.userCode)}</dd>
              </div>
              <dd className="text-xs text-text-muted">
                {t('expiresAt', { time: format.dateTime(new Date(view.expiresAt), { timeStyle: 'short' }) })}
              </dd>
            </dl>
          </div>
          <Alert tone="warning">{t('warning')}</Alert>
          <section aria-labelledby="device-permissions" className="flex flex-col gap-3">
            <h2 id="device-permissions" className="text-base font-medium text-text">
              {t('permissions')}
            </h2>
            <ul className="flex flex-col gap-2">
              {scopes.map(({ scope, label }) => (
                <Permission key={scope} icon={SCOPE_ICONS[scope] ?? User}>
                  {label}
                </Permission>
              ))}
            </ul>
          </section>
        </DeviceRequest>
      </AuthShell>
    </DeviceSelectionProvider>
  )
}

function Permission({ icon: Icon, children }: { icon: ComponentType<SVGProps<SVGSVGElement>>; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-base text-text">
      <Icon aria-hidden className="shrink-0 text-text-muted" />
      <span className="pt-0.5 text-sm">{children}</span>
    </li>
  )
}

/** 输入用户代码：普通的 GET 表单，回到这一页带上 user_code，不需要 JS */
async function CodeForm({ defaultValue }: { defaultValue?: string }) {
  const t = await getTranslations('device')
  return (
    <form action="/device" method="get" className="flex flex-col gap-4">
      <Field label={t('code')} name="user_code" description={t('codeHint')}>
        <Input
          required
          maxLength={64}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          defaultValue={defaultValue}
        />
      </Field>
      <Button type="submit" variant="primary" size="lg" fullWidth>
        {t('continue')}
      </Button>
    </form>
  )
}
