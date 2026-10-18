import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@nextskin/domain'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getServer } from '../../lib/server'
import { getRequestRoot } from '../../lib/session'
import { FullscreenShell } from '../_import/fullscreen-shell'
import { RunPanel } from '../_import/run-panel'
import { SetupCodeForm } from './setup-code-form'
import { SetupStart } from './setup-start'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('setup')
  return { title: t('title') }
}

/**
 * 安装向导（ADR-0031）：只在站点未初始化时可用（没有用户，也没有成功的导入），之后一律 404。
 * 先输入数据目录里 setup-code 文件的安装码，再选“新站”或“从 BS 导入”。从向导发起的导入在这里看进度：维护期间这一页仍然能打开
 */
export default async function SetupPage() {
  const [{ core, importer }, cookieStore, t] = await Promise.all([getServer(), cookies(), getTranslations('setup')])
  if (await core.setup.isInitialized()) notFound()
  const runToken = cookieStore.get('nextskin-import-run')?.value
  const run = runToken ? importer.run(runToken) : null
  const verified = await core.setup.verifySession(cookieStore.get('nextskin-setup')?.value ?? '')
  const { 'site.name': siteName } = await core.settings.read(['site.name'])

  return (
    <FullscreenShell>
      {run?.status === 'running' ? (
        <RunPanel initial={run} />
      ) : verified ? (
        <SetupStart
          siteName={siteName}
          siteUrl={await getRequestRoot()}
          password={{ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH }}
        />
      ) : (
        <section className="flex flex-col gap-6">
          <header className="flex flex-col gap-1">
            <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
            <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
          </header>
          <SetupCodeForm />
        </section>
      )}
    </FullscreenShell>
  )
}
