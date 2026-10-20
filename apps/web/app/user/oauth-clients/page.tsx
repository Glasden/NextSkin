import type { OAuthClientView } from '@nextskin/domain'
import { Alert, Badge, EmptyState } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getFormatter, getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { Code } from 'pixelarticons/react/Code.js'
import { Globe } from 'pixelarticons/react/Globe.js'
import { Monitor } from 'pixelarticons/react/Monitor.js'
import type { ReactNode } from 'react'
import { oauthIssuer } from '../../../lib/oauth'
import { getServer } from '../../../lib/server'
import { getRequestRoot, requireUser } from '../../../lib/session'
import { VerifyEmailAlert } from '../verify-email-alert'
import { ClientActions, CreateClientDialog } from './client-dialogs'
import { CopyValueButton } from './copy-value-button'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('user.oauthClients')
  return { title: t('title') }
}

/**
 * 用户中心的 OAuth 应用（ADR-0037"用户中心的'OAuth 应用'"）：自己创建、导入时归到自己名下的应用。
 * 写操作由用例检查封禁和邮箱验证（ADR-0018）；这里只是不让用户点了才知道不行
 */
export default async function OAuthClientsPage() {
  const user = await requireUser('/user/oauth-clients')
  const { core } = await getServer()
  const [overview, clients, settings, mailConfigured, root, t] = await Promise.all([
    core.users.overview(user.uid),
    core.oauth.listClients(user.uid),
    core.settings.read(['site.url', 'auth.requireEmailVerification']),
    core.mail.configured(),
    getRequestRoot(),
    getTranslations('user.oauthClients'),
  ])
  if (!overview) redirect('/sign-in')
  const banned = overview.role === 'banned'
  const unverified = settings['auth.requireEmailVerification'] && !overview.emailVerified
  const locked = banned || unverified
  const issuer = oauthIssuer(settings['site.url'], root)
  const create = <CreateClientDialog disabled={locked} />

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-baseline gap-3 font-pixel text-pixel-2 text-text">
            {t('title')}
            {clients.length > 0 && (
              <span className="text-pixel-1 text-text-muted tabular-nums">{t('count', { count: clients.length })}</span>
            )}
          </h1>
          <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
        </div>
        {clients.length > 0 && <div className="shrink-0">{create}</div>}
      </header>

      {banned ? (
        <Alert tone="danger">{t('banned')}</Alert>
      ) : (
        unverified && <VerifyEmailAlert email={overview.email} mailConfigured={mailConfigured} />
      )}

      {clients.length ? (
        <ul aria-label={t('listLabel')} className="flex flex-col gap-4">
          {clients.map((client) => (
            <ClientItem key={client.id} client={client} locked={locked} />
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Code />} title={t('emptyTitle')} description={t('emptyDescription')} action={create} />
      )}

      <section aria-labelledby="oauth-integration" className="flex flex-col gap-3">
        <h2 id="oauth-integration" className="font-pixel text-pixel-1 text-text">
          {t('integration.title')}
        </h2>
        <p className="text-sm text-pretty text-text-muted">{t('integration.description')}</p>
        <dl className="flex flex-col divide-y divide-border rounded-sm border border-border">
          <Fact label={t('integration.discovery')}>
            <span className="flex items-start gap-1">
              <code className="min-w-0 flex-1 py-1.5 font-mono text-sm break-all text-text select-all">
                {`${issuer}/.well-known/openid-configuration`}
              </code>
              <CopyValueButton
                value={`${issuer}/.well-known/openid-configuration`}
                label={t('integration.copyDiscovery')}
                done={t('integration.discoveryCopied')}
              />
            </span>
          </Fact>
          <Fact label={t('integration.issuer')}>
            <code className="block py-1.5 font-mono text-sm break-all text-text select-all">{issuer}</code>
          </Fact>
          <Fact label={t('types.web')}>
            <p className="py-1.5 text-sm text-pretty text-text">{t('integration.web')}</p>
          </Fact>
          <Fact label={t('types.native')}>
            <p className="py-1.5 text-sm text-pretty text-text">{t('integration.native')}</p>
          </Fact>
        </dl>
      </section>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-2 sm:flex-row sm:items-start sm:gap-6">
      <dt className="text-sm text-text-muted sm:w-40 sm:shrink-0 sm:pt-1.5">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  )
}

/** 一个应用：名称和类型、client_id、能走的流程、回调地址，底部是操作 */
async function ClientItem({ client, locked }: { client: OAuthClientView; locked: boolean }) {
  const [t, oauth, format] = await Promise.all([
    getTranslations('user.oauthClients'),
    getTranslations('oauth'),
    getFormatter(),
  ])
  const name = client.name ?? oauth('unnamedClient')
  const Icon = client.type === 'web' ? Globe : Monitor
  const flows = [
    client.redirectUris.length > 0 && t('flows.authorizationCode'),
    client.deviceCode && t('flows.deviceCode'),
  ].filter((flow): flow is string => Boolean(flow))
  return (
    <li className="flex flex-col overflow-hidden rounded-md border border-border bg-surface">
      <div className="flex items-start gap-3 p-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-surface-sunken text-text-muted">
          <Icon aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {/* 应用名是用户填的，用正文字体（DESIGN.md §4），完整显示，同同意页 */}
            <h2 className="text-lg font-medium wrap-anywhere text-text">{name}</h2>
            <Badge>{t(`types.${client.type}`)}</Badge>
            {client.disabled && <Badge tone="danger">{t('disabled')}</Badge>}
          </div>
          <p className="text-sm text-text-muted">
            {t('meta', {
              time: format.dateTime(new Date(client.createdAt), { dateStyle: 'medium' }),
              count: client.authorizedUsers,
            })}
          </p>
        </div>
      </div>
      {client.disabled && (
        <div className="px-4 pb-4">
          <Alert tone="warning">{t('disabledHint')}</Alert>
        </div>
      )}
      <dl className="flex flex-col divide-y divide-border border-t border-border">
        <Fact label={t('clientId')}>
          <span className="flex items-start gap-1">
            <code className="min-w-0 flex-1 py-1.5 font-mono text-sm break-all text-text select-all">
              {client.clientId}
            </code>
            <CopyValueButton value={client.clientId} label={t('copyClientId')} done={t('clientIdCopied')} />
          </span>
        </Fact>
        <Fact label={t('flowsLabel')}>
          <p className="py-1.5 text-sm text-text">{flows.length ? format.list(flows) : t('flows.none')}</p>
        </Fact>
        <Fact label={t('redirectUris')}>
          {client.redirectUris.length ? (
            <ul className="flex flex-col py-1.5">
              {client.redirectUris.map((uri) => (
                <li key={uri} className="font-mono text-sm break-all text-text">
                  {uri}
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-1.5 text-sm text-text-muted">{t('noRedirectUris')}</p>
          )}
        </Fact>
      </dl>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-surface-sunken px-4 py-3">
        <ClientActions
          client={{
            id: client.id,
            name,
            type: client.type,
            redirectUris: client.redirectUris,
            deviceCode: client.deviceCode,
            authorizedUsers: client.authorizedUsers,
          }}
          locked={locked}
        />
      </div>
    </li>
  )
}
