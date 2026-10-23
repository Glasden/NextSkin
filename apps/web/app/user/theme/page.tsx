import { Alert } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getServer } from '../../../lib/server'
import { requireUser } from '../../../lib/session'
import { themeLabeler } from '../../../lib/themes'
import { ColorModeControl } from './color-mode-control'
import { FOLLOW_DEFAULT, ThemeChooser } from './theme-chooser'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('user.theme')
  return { title: t('title') }
}

/**
 * 外观（ADR-0057）：上面是亮暗模式（按设备记在 Cookie 里，和页头的菜单是同一个），下面挑配色主题（存进账号）。
 * 第一项跟随站点默认，小样画站点默认的那套；选的主题停用了时写明现在跟随站点默认
 */
export default async function UserThemePage() {
  const user = await requireUser('/user/theme')
  const [{ core }, t] = await Promise.all([getServer(), getTranslations('user.theme')])
  const [view, label] = await Promise.all([core.themes.userView(user.uid), themeLabeler(core)])
  // 站点默认的那套可能不在启用的列表里：默认主题的插件停用了，回落到被关掉的钻石青
  const siteDefault = view.themes.find((theme) => theme.id === view.siteDefault)
  const siteDefaultName = label(siteDefault ?? { pluginId: null, label: view.siteDefault }).name

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>

      <section aria-labelledby="color-mode-heading" className="flex flex-col gap-3">
        <h2 id="color-mode-heading" className="font-pixel text-pixel-1 text-text">
          {t('colorMode')}
        </h2>
        <ColorModeControl />
        <p className="text-sm text-pretty text-text-muted">{t('colorModeHint')}</p>
      </section>

      <section aria-labelledby="themes-heading" className="flex flex-col gap-3">
        <h2 id="themes-heading" className="font-pixel text-pixel-1 text-text">
          {t('themes')}
        </h2>
        {view.stale && <Alert tone="warning">{t('stale')}</Alert>}
        {/* 主题 id 和色值都校验过格式（packages/theme 的 themeCss），拼不出别的东西 */}
        <style dangerouslySetInnerHTML={{ __html: view.previewCss }} />
        <ThemeChooser
          aria-label={t('themes')}
          selected={view.stale ? FOLLOW_DEFAULT : (view.selected ?? FOLLOW_DEFAULT)}
          options={[
            {
              value: FOLLOW_DEFAULT,
              theme: view.siteDefault,
              name: t('followDefault'),
              description: t('followDefaultDescription', { name: siteDefaultName }),
            },
            ...view.themes.map((theme) => {
              const { name, source } = label(theme)
              return { value: theme.id, theme: theme.id, name, description: source ?? t('builtin') }
            }),
          ]}
        />
      </section>
    </div>
  )
}
