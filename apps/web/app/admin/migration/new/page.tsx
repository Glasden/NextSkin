import { Link } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../../../lib/server'
import { getRequestRoot, requireAdmin } from '../../../../lib/session'
import { ImportWizard } from '../../../_import/import-wizard'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.migration')
  return { title: t('newTitle') }
}

/**
 * 从后台发起导入（ADR-0031）：已经在用的站点做切换前的最终同步，或者用“新站”建好的站点后来要导入旧数据。
 * 表单预填上一次运行的非机密项；数据库密码和盐每次重新输入
 */
export default async function NewMigrationPage() {
  const user = await requireAdmin('/admin/migration/new', 'import.manage')
  const { core, importer } = await getServer()
  await core.admin.requirePermission(user.uid, 'import.manage')
  const { 'site.url': configured } = await core.settings.read(['site.url'])
  const [defaults, root, t] = await Promise.all([
    importer.lastSource(),
    getRequestRoot(),
    getTranslations('admin.migration'),
  ])

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="text-sm">
          <Link render={<NextLink href="/admin/migration" />}>{t('backToList')}</Link>
        </span>
        <h1 className="font-pixel text-pixel-2 text-text">{t('newTitle')}</h1>
        <p className="max-w-3xl text-sm text-pretty text-text-muted">{t('newDescription')}</p>
      </header>
      <div className="max-w-4xl">
        <ImportWizard base="/api/admin/import" defaults={defaults} siteUrl={configured || root} />
      </div>
    </div>
  )
}
