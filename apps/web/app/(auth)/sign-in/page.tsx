import { Alert } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { externalErrorMessage, externalProviders } from '../../../lib/external-login'
import { getServer } from '../../../lib/server'
import { getAuthorizationContinuation, getSessionUser, safeNextPath, searchString } from '../../../lib/session'
import { AuthHeading } from '../auth-heading'
import { AuthLink } from '../auth-link'
import { SignInForm } from './sign-in-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signIn')
  return { title: t('title') }
}

/**
 * 第三方登录出错时，回调带着 `?error=` 跳回这里（ADR-0034）。授权流程没登录时，Better Auth 带着签过名的参数
 * 跳过来，登录以后回到授权流程（ADR-0037"登录后续跑"）
 */
export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const query = await searchParams
  const continuation = await getAuthorizationContinuation(searchString(query))
  // 已经登录还被送来：第三方网站跨站 POST 发起的授权看不到会话 Cookie（SameSite=Lax），直接回去
  if (continuation?.resume) redirect(continuation.next)
  const next = continuation?.next ?? safeNextPath(query.next)
  const [t, providers, error, user, captcha] = await Promise.all([
    getTranslations('auth.signIn'),
    externalProviders(),
    externalErrorMessage(query.error),
    getSessionUser(),
    getServer().then(({ core }) => core.captcha.publicConfig()),
  ])
  // 应用要求重新登录（prompt=login、max_age）时，已经登录也显示表单。重新登录时用第三方账号出了错，
  // 回来时带着错误和 next，也留在这一页说明原因
  const reauthenticate = continuation !== null && user !== null
  if (!continuation && user && !error) redirect(next)
  return (
    <>
      <AuthHeading title={t('title')}>
        {/* 重新登录时不给注册：已经登录的人打开注册页会直接回到 next，不用再登录一次 */}
        {!user && (
          <>
            {t('noAccount')}{' '}
            <AuthLink href={`/sign-up?next=${encodeURIComponent(next)}`} next={next}>
              {t('signUp')}
            </AuthLink>
          </>
        )}
      </AuthHeading>
      {error && (
        <div className="mb-6">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {reauthenticate && (
        <div className="mb-6">
          <Alert>{t('reauthenticate')}</Alert>
        </div>
      )}
      <SignInForm next={next} providers={providers} captcha={captcha} />
    </>
  )
}
