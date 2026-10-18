import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { getSessionUser, safeNextPath } from '../../../../lib/session'
import { AuthHeading } from '../../auth-heading'
import { TwoFactorForm } from './two-factor-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.twoFactor')
  return { title: t('title') }
}

/**
 * 登录的第二步：密码通过后 Better Auth 返回 twoFactorRedirect，留下一个 10 分钟有效的挑战 Cookie，
 * 在这里输入验证器上的数字或者备用码（ADR-0023）。直接打开、挑战过期时，提交会提示重新登录
 */
export default async function TwoFactorPage({ searchParams }: PageProps<'/sign-in/two-factor'>) {
  const next = safeNextPath((await searchParams).next)
  if (await getSessionUser()) redirect(next)
  const t = await getTranslations('auth.twoFactor')
  return (
    <>
      <AuthHeading title={t('title')} />
      <TwoFactorForm next={next} />
    </>
  )
}
