import { ButtonLink } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { AuthShell } from '../../(auth)/auth-shell'
import { AuthorizationNotice } from '../../_oauth/authorization-parts'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('oauth.error')
  return { title: t('title') }
}

/** Better Auth 的错误码到文案的键名；认不出的码按"授权请求有误"显示 */
const MESSAGES = {
  invalid_client: 'invalidClient',
  client_disabled: 'clientDisabled',
  unauthorized_client: 'unauthorizedClient',
  invalid_redirect: 'invalidRedirect',
} as const

/**
 * 授权请求不能重定向回应用时的站内错误页（ADR-0037"scope 错误的重定向"）：应用不存在、停用，回调地址没登记……
 * 设成 Better Auth 的 `onAPIError.errorURL`。只按 `error` 显示一句说明，不显示 `error_description`：
 * 那是请求方能左右的英文原文
 */
export default async function OAuthErrorPage({ searchParams }: PageProps<'/oauth/error'>) {
  const { error } = await searchParams
  const t = await getTranslations('oauth.error')
  const key =
    typeof error === 'string' && Object.hasOwn(MESSAGES, error)
      ? MESSAGES[error as keyof typeof MESSAGES]
      : 'invalidRequest'
  return (
    <AuthShell>
      <AuthorizationNotice
        title={t('title')}
        action={
          <ButtonLink size="lg" render={<NextLink href="/" />}>
            {t('home')}
          </ButtonLink>
        }
      >
        <p>{t(key)}</p>
        <p className="text-sm text-text-muted">{t('hint')}</p>
      </AuthorizationNotice>
    </AuthShell>
  )
}
