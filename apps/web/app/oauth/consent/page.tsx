import { SELECT_SCOPE } from '@nextskin/domain'
import { ButtonLink } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { Globe } from 'pixelarticons/react/Globe.js'
import { Monitor } from 'pixelarticons/react/Monitor.js'
import { clientLabel } from '../../../lib/oauth'
import { getServer } from '../../../lib/server'
import { getRequestRoot, getSessionUser, searchString } from '../../../lib/session'
import { AuthHeading } from '../../(auth)/auth-heading'
import { AuthShell, DefaultIllustration } from '../../(auth)/auth-shell'
import {
  AuthorizationNotice,
  authorizationBlock,
  authorizationPlayers,
  ClientCard,
  PermissionList,
} from '../../_oauth/authorization-parts'
import { PlayerSelectionProvider, PlayerStage } from '../../_oauth/player-selection'
import { ConsentRequest, SwitchAccount } from './consent-request'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('oauth.consent')
  return { title: t('title') }
}

/** 回调到这台电脑上：启动器用环回地址加随机端口接授权码（RFC 8252） */
function isLoopback(host: string): boolean {
  const hostname = host.replace(/:\d+$/, '')
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

/**
 * 授权码流程的同意页（ADR-0037"页面"）：Better Auth 带着签过名的参数跳过来，显示应用、回调地址的主机、
 * 申请的权限，申请了 Select 时选角色。地址上的参数先在服务端验签：伪造的地址能把任意应用名和回调主机显示在
 * 本站页面上。不放进 (auth) 分组：展台上换成所选的角色
 */
export default async function ConsentPage({ searchParams }: PageProps<'/oauth/consent'>) {
  const search = searchString(await searchParams)
  const user = await getSessionUser()
  // 签名参数和登录页的格式相同：带着去登录，登录以后经授权地址再回到这里（ADR-0037"登录后续跑"）
  if (!user) redirect(`/sign-in?${search}`)
  const [{ core }, root, t] = await Promise.all([getServer(), getRequestRoot(), getTranslations('oauth')])
  const view = await core.auth.consentRequest(search, root)

  if (view.status === 'invalid')
    return (
      <AuthShell>
        <AuthorizationNotice
          title={t('consent.invalidTitle')}
          action={
            <ButtonLink size="lg" render={<NextLink href="/" />}>
              {t('error.home')}
            </ButtonLink>
          }
        >
          <p>{t('consent.invalid')}</p>
          <p className="text-sm text-text-muted">{t('error.hint')}</p>
        </AuthorizationNotice>
      </AuthShell>
    )

  const settings = await core.settings.read(['site.name'])
  const choosePlayer = view.scopes.includes(SELECT_SCOPE)
  const [client, players, blocked] = await Promise.all([
    clientLabel(view.client, settings['site.name']),
    choosePlayer ? authorizationPlayers(user.uid) : Promise.resolve([]),
    authorizationBlock(user),
  ])
  // 申请 Select 时必须选角色；只有一个角色时默认选中，仍要用户点"授权"（ADR-0037"角色绑定"）
  const initial = players.length === 1 ? players[0]!.pid : null
  const loopback = isLoopback(view.redirectHost)
  const illustration = (scale: 4 | 8) => (
    <PlayerStage players={players} scale={scale} fallback={<DefaultIllustration scale={scale} />} />
  )

  return (
    <PlayerSelectionProvider initial={initial}>
      <AuthShell illustration={illustration}>
        <ConsentRequest oauthQuery={view.oauthQuery} players={players} choosePlayer={choosePlayer} blocked={blocked}>
          <AuthHeading title={t('consent.title')}>
            {t('consent.signedInAs', { nickname: user.nickname })} <SwitchAccount oauthQuery={view.oauthQuery} />
          </AuthHeading>
          <ClientCard icon={loopback ? Monitor : Globe} name={client.name} byline={client.byline}>
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-xs text-text-muted">{t('consent.redirectLabel')}</dt>
              {/* 主机名由应用登记，长的也要完整显示，按字符折行 */}
              <dd className="font-mono text-base break-all text-text">{view.redirectHost}</dd>
            </div>
            {loopback && <dd className="text-xs text-text-muted">{t('consent.loopback')}</dd>}
          </ClientCard>
          <PermissionList scopes={view.scopes} />
        </ConsentRequest>
      </AuthShell>
    </PlayerSelectionProvider>
  )
}
