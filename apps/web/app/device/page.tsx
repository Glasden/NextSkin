import { DomainError, SELECT_SCOPE } from '@nextskin/domain'
import { Alert, Button, Field, Input } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import { Monitor } from 'pixelarticons/react/Monitor.js'
import { clientLabel } from '../../lib/oauth'
import { getServer } from '../../lib/server'
import { requireUser } from '../../lib/session'
import { AuthHeading } from '../(auth)/auth-heading'
import { AuthShell, DefaultIllustration } from '../(auth)/auth-shell'
import { authorizationBlock, authorizationPlayers, ClientCard, PermissionList } from '../_oauth/authorization-parts'
import { PlayerSelectionProvider, PlayerStage } from '../_oauth/player-selection'
import { DeviceRequest } from './device-request'
import { DeviceResult } from './device-result'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('device')
  return { title: t('title') }
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

  const settings = await core.settings.read(['site.name'])
  const client = await clientLabel(view.client, settings['site.name'])
  // 本人已经处理过、启动器还没来兑换
  if (view.status !== 'pending')
    return (
      <AuthShell>
        <DeviceResult status={view.status} clientName={client.name} />
      </AuthShell>
    )

  const choosePlayer = view.scopes.includes(SELECT_SCOPE)
  const [players, blocked, format] = await Promise.all([
    choosePlayer ? authorizationPlayers(user.uid) : Promise.resolve([]),
    authorizationBlock(user),
    getFormatter(),
  ])
  // 申请 Select 时必须选角色；只有一个角色时默认选中，仍要用户点"授权"（ADR-0037"角色绑定"）
  const initial = players.length === 1 ? players[0]!.pid : null
  const illustration = (scale: 4 | 8) => (
    <PlayerStage players={players} scale={scale} fallback={<DefaultIllustration scale={scale} />} />
  )

  return (
    <PlayerSelectionProvider initial={initial}>
      <AuthShell illustration={illustration}>
        <DeviceRequest
          userCode={view.userCode}
          clientName={client.name}
          players={players}
          choosePlayer={choosePlayer}
          blocked={blocked}
        >
          <AuthHeading title={t('requestTitle')} />
          <ClientCard icon={Monitor} name={client.name} byline={client.byline}>
            <div className="flex flex-col gap-1">
              <dt className="text-xs text-text-muted">{t('codeLabel')}</dt>
              <dd className="font-mono text-xl tracking-widest text-text">{formatUserCode(view.userCode)}</dd>
            </div>
            <dd className="text-xs text-text-muted">
              {t('expiresAt', { time: format.dateTime(new Date(view.expiresAt), { timeStyle: 'short' }) })}
            </dd>
          </ClientCard>
          <Alert tone="warning">{t('warning')}</Alert>
          <PermissionList scopes={view.scopes} />
        </DeviceRequest>
      </AuthShell>
    </PlayerSelectionProvider>
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
