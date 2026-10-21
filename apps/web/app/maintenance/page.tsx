import { hasAdminAccess } from '@nextskin/domain'
import type { TextureType } from '@nextskin/skin'
import figure from '@nextskin/skin/assets/figures/default-skin-k1.png'
import figures from '@nextskin/skin/assets/figures/manifest.json'
import { Markdown, SkinFigure, Stage } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { getServer } from '../../lib/server'
import { getSessionUser } from '../../lib/session'
import { FullscreenShell } from '../_import/fullscreen-shell'
import { RunPanel } from '../_import/run-panel'
import { SignOutButton } from '../user/user-menu'
import { AdminSignInLink } from './admin-sign-in-link'
import { AutoRefresh } from './auto-refresh'

const defaultSkin = {
  type: figures.figures['default-skin'].type as TextureType,
  textureScale: figures.figures['default-skin'].textureScale,
  src: () => figure.src,
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('maintenance')
  return { title: t('title') }
}

/**
 * 维护页：两种维护模式下别的页面都由 proxy 换成这一页，地址不变。
 * - 导入期间（ADR-0031）：发起这次运行的浏览器带着运行令牌的 Cookie，在这里看进度、取消和最后的报告；其他人看到维护说明。
 *   这时不查会话：Better Auth 可能顺手给会话续期，而写锁在导入的事务手里。
 * - 手动维护（ADR-0044）：站长写的说明、游戏里受不受影响；没登录的给管理员登录的入口，登录的不是管理员时给退出登录
 *   （登录页对已登录的人直接跳走，不退出就换不了账号）。管理员打开这一页，看到的就是普通用户看到的样子。
 * 都每 30 秒刷新一次；不在维护时跳回首页
 */
export default async function MaintenancePage() {
  const [{ core, importer }, cookieStore, t] = await Promise.all([
    getServer(),
    cookies(),
    getTranslations('maintenance'),
  ])
  const token = cookieStore.get('nextskin-import-run')?.value
  const run = token ? importer.run(token) : null
  if (run)
    return (
      <FullscreenShell>
        <RunPanel initial={run} />
      </FullscreenShell>
    )
  if (importer.maintenance())
    return (
      <Layout title={t('title')} illustration={t('illustration')}>
        <p className="text-base text-pretty text-text">{t('description')}</p>
        <p className="text-sm text-pretty text-text-muted">{t('refresh')}</p>
      </Layout>
    )

  const settings = await core.settings.read([
    'maintenance.enabled',
    'maintenance.blockProtocols',
    'maintenance.message',
  ])
  if (!settings['maintenance.enabled']) redirect('/')
  const user = await getSessionUser()
  const message = settings['maintenance.message'].trim()
  return (
    <Layout title={t('title')} illustration={t('illustration')}>
      {message ? (
        <Markdown headingLevel={1}>{message}</Markdown>
      ) : (
        <p className="text-base text-pretty text-text">{t('manualDescription')}</p>
      )}
      <p className="text-sm text-pretty text-text-muted">
        {settings['maintenance.blockProtocols'] ? t('protocolsBlocked') : t('protocolsOpen')}
      </p>
      <p className="text-sm text-pretty text-text-muted">{t('manualRefresh')}</p>
      {!user && (
        <p className="pt-3 text-sm">
          <AdminSignInLink>{t('adminSignIn')}</AdminSignInLink>
        </p>
      )}
      {user && !hasAdminAccess(user.role) && (
        <div className="flex flex-col items-start gap-3 pt-3">
          <p className="text-sm text-pretty text-text-muted">{t('notAdmin')}</p>
          <SignOutButton />
        </div>
      )}
    </Layout>
  )
}

/** 左边是标题和说明，右边是站在展台上的默认皮肤；窄屏时上下排 */
function Layout({ title, illustration, children }: { title: string; illustration: string; children: ReactNode }) {
  return (
    <FullscreenShell>
      <div className="flex flex-col gap-8 md:flex-row md:items-center">
        <div className="flex flex-1 flex-col gap-3">
          <h1 className="font-pixel text-pixel-2 text-text">{title}</h1>
          {children}
          <AutoRefresh />
        </div>
        <div className="h-72 md:w-72 md:shrink-0">
          <Stage grid>
            <SkinFigure {...defaultSkin} scale={4} alt={illustration} turnOnHover loading="eager" />
          </Stage>
        </div>
      </div>
    </FullscreenShell>
  )
}
