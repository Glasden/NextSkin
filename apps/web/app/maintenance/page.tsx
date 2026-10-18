import type { TextureType } from '@nextskin/skin'
import figure from '@nextskin/skin/assets/figures/default-skin-k1.png'
import figures from '@nextskin/skin/assets/figures/manifest.json'
import { SkinFigure, Stage } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getServer } from '../../lib/server'
import { FullscreenShell } from '../_import/fullscreen-shell'
import { RunPanel } from '../_import/run-panel'
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
 * 维护页（ADR-0031）：导入期间别的页面都由 proxy 换成这一页，地址不变。
 * 发起这次运行的浏览器带着运行令牌的 Cookie，在这里看进度、取消和最后的报告；其他人看到维护说明，页面每 30 秒刷新一次
 */
export default async function MaintenancePage() {
  const [{ importer }, cookieStore, t] = await Promise.all([getServer(), cookies(), getTranslations('maintenance')])
  const token = cookieStore.get('nextskin-import-run')?.value
  const run = token ? importer.run(token) : null
  if (!run && !importer.maintenance()) redirect('/')

  return (
    <FullscreenShell>
      {run ? (
        <RunPanel initial={run} />
      ) : (
        <div className="flex flex-col gap-8 md:flex-row md:items-center">
          <div className="flex flex-1 flex-col gap-3">
            <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
            <p className="text-base text-pretty text-text">{t('description')}</p>
            <p className="text-sm text-pretty text-text-muted">{t('refresh')}</p>
            <AutoRefresh />
          </div>
          <div className="h-72 md:w-72 md:shrink-0">
            <Stage grid>
              <SkinFigure {...defaultSkin} scale={4} alt={t('illustration')} turnOnHover loading="eager" />
            </Stage>
          </div>
        </div>
      )}
    </FullscreenShell>
  )
}
