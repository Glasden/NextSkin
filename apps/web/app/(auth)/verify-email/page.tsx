import { Alert, Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { redirect } from 'next/navigation'
import { AuthHeading } from '../auth-heading'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.verifyEmail')
  return { title: t('title') }
}

/**
 * 验证邮件里的链接先到 Better Auth 校验令牌，再跳到这里：成功时带 ?status=verified（注册时发信指定的回跳地址），
 * 失败时 Better Auth 再加上 ?error=…。直接打开这个地址时回首页
 */
export default async function VerifyEmailPage({ searchParams }: PageProps<'/verify-email'>) {
  const [{ status, error }, t] = await Promise.all([searchParams, getTranslations('auth.verifyEmail')])
  if (!error && status !== 'verified') redirect('/')
  return (
    <>
      <AuthHeading title={t('title')} />
      <div className="flex flex-col gap-6">
        {error ? (
          <Alert tone="danger">{t('invalidLink')}</Alert>
        ) : (
          <Alert tone="success" title={t('doneTitle')}>
            {t('done')}
          </Alert>
        )}
        <p className="text-sm">
          <Link render={<NextLink href="/" />}>{t('home')}</Link>
        </p>
      </div>
    </>
  )
}
