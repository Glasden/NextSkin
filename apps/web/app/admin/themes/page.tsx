import { Badge, Link, ThemeCard } from '@nextskin/ui'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../../../lib/server'
import { requireAdmin } from '../../../lib/session'
import { previewCss, themeLabeler } from '../../../lib/themes'
import { ThemeActions } from './theme-actions'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.themes')
  return { title: t('title') }
}

/**
 * 配色主题（ADR-0057）：每套可用的主题一张卡片，启用开关和“设为默认”；没通过检查的、启用了但暂时用不上的另外列出。
 * 只有超级管理员能进来（settings.manage），写操作走 PATCH /api/admin/themes
 */
export default async function AdminThemesPage() {
  const user = await requireAdmin('/admin/themes', 'settings.manage')
  const [{ core }, t] = await Promise.all([getServer(), getTranslations('admin.themes')])
  const [view, label] = await Promise.all([core.themes.adminView({ uid: user.uid, ip: null }), themeLabeler(core)])

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="font-pixel text-pixel-2 text-text">{t('title')}</h1>
        <p className="max-w-3xl text-sm text-pretty text-text-muted">{t('description')}</p>
      </header>

      {/* 主题 id 和色值都校验过格式（packages/theme 的 themeCss），拼不出别的东西 */}
      <style dangerouslySetInnerHTML={{ __html: previewCss(view.themes) }} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {view.themes.map((theme) => {
          const { name, source } = label(theme)
          return (
            <ThemeCard
              key={theme.id}
              theme={theme.id}
              name={name}
              description={
                theme.pluginId === null ? (
                  t('builtin')
                ) : (
                  <Link render={<NextLink href={`/admin/plugins/${theme.pluginId}`} />}>{source}</Link>
                )
              }
              badge={theme.default && <Badge>{t('default')}</Badge>}
              selected={theme.default ? t('default') : undefined}
              actions={<ThemeActions id={theme.id} name={name} enabled={theme.enabled} isDefault={theme.default} />}
            />
          )
        })}
      </div>
      {view.themes.length === 1 && view.invalid.length === 0 && (
        <p className="max-w-3xl text-sm text-pretty text-text-muted">
          {t('noPlugins')} <Link render={<NextLink href="/admin/plugins" />}>{t('pluginsLink')}</Link>
        </p>
      )}

      {view.invalid.length > 0 && (
        <section aria-labelledby="invalid-heading" className="flex flex-col gap-3">
          <header className="flex flex-col gap-1">
            <h2 id="invalid-heading" className="font-pixel text-pixel-1 text-text">
              {t('invalid.title')}
            </h2>
            <p className="max-w-3xl text-sm text-pretty text-text-muted">{t('invalid.description')}</p>
          </header>
          <ul className="divide-y divide-border rounded-md border border-border bg-surface">
            {view.invalid.map((theme) => {
              const { name, source } = label(theme)
              return (
                <li key={theme.id} className="flex flex-col gap-1 px-4 py-3">
                  <p className="flex flex-wrap items-center gap-x-2 text-base text-text">
                    <span className="font-medium">{name}</span>
                    <Link render={<NextLink href={`/admin/plugins/${theme.pluginId}`} />}>{source}</Link>
                  </p>
                  <ul className="flex flex-col gap-0.5 text-sm text-danger">
                    {theme.issues.map((issue) => {
                      const digits = issue.check === 'contrast' ? 2 : 3
                      return (
                        <li key={`${issue.mode}:${issue.check}:${issue.pair.join()}`}>
                          {t('issue', {
                            mode: issue.mode,
                            check: issue.check,
                            first: issue.pair[0],
                            second: issue.pair[1],
                            values: issue.values.join(' / '),
                            actual: issue.check === 'lightness' ? '' : issue.actual.toFixed(digits),
                            minimum: issue.check === 'lightness' ? '' : issue.minimum.toFixed(digits),
                          })}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {view.missing.length > 0 && (
        <section aria-labelledby="missing-heading" className="flex flex-col gap-3">
          <header className="flex flex-col gap-1">
            <h2 id="missing-heading" className="font-pixel text-pixel-1 text-text">
              {t('missing.title')}
            </h2>
            <p className="max-w-3xl text-sm text-pretty text-text-muted">{t('missing.description')}</p>
          </header>
          <ul className="divide-y divide-border rounded-md border border-border bg-surface">
            {view.missing.map((id) => (
              <li key={id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
                <code className="font-mono text-sm break-all text-text">{id}</code>
                <ThemeActions id={id} name={id} enabled isDefault={false} missing />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
