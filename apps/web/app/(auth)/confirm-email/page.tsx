import { Alert, Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../../lib/server'
import { AuthHeading } from '../auth-heading'
import { ConfirmEmailForm } from './confirm-email-form'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.confirmEmail')
  return { title: t('title') }
}

/**
 * 确认新邮箱：确认邮件里的链接打开这一页，点按钮才提交（ADR-0023）。有些邮件服务会预先打开邮件里的链接做安全扫描，
 * 所以打开页面本身不改数据。不要求登录：用户可能在手机上打开邮件
 */
export default async function ConfirmEmailPage({ searchParams }: PageProps<'/confirm-email'>) {
  const [{ token }, { core }, t] = await Promise.all([searchParams, getServer(), getTranslations('auth.confirmEmail')])
  const preview = typeof token === 'string' ? await core.users.previewEmailChange(token) : null
  return (
    <>
      <AuthHeading title={t('title')} />
      {preview && typeof token === 'string' ? (
        <ConfirmEmailForm token={token} email={preview.email} />
      ) : (
        <div className="flex flex-col gap-6">
          <Alert tone="danger">{t('invalidLink')}</Alert>
          <p className="text-sm">
            <Link render={<NextLink href="/user/profile" />}>{t('profile')}</Link>
          </p>
        </div>
      )}
    </>
  )
}
