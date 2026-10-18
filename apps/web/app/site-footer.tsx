import { Link, Logo, Markdown } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { getServer } from '../lib/server'

const COLUMNS = [
  {
    key: 'site',
    links: [
      { key: 'skinlib', href: '/skinlib' },
      { key: 'upload', href: '/skinlib/upload' },
    ],
  },
  {
    key: 'account',
    links: [
      { key: 'userCenter', href: '/user' },
      { key: 'closet', href: '/user/closet' },
      { key: 'players', href: '/user/players' },
    ],
  },
] as const

/**
 * 全站页脚：首页、皮肤库和用户中心用（ADR-0032）。底部一行是站长在后台写的 site.footer（Markdown，一般放备案号），
 * 没写时是“© 年份 站点名”；右边固定写“由 NextSkin 驱动”，不带版本号
 */
export async function SiteFooter() {
  const [{ core }, t, home] = await Promise.all([getServer(), getTranslations('site.footer'), getTranslations('home')])
  const settings = await core.settings.read(['site.name', 'site.description', 'site.footer', 'site.timeZone'])
  const year = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: settings['site.timeZone'] }).format(
    new Date(),
  )
  const custom = settings['site.footer'].trim()
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-8 px-4 py-10 sm:px-6 lg:grid-cols-4">
        <div className="col-span-2 flex flex-col items-start gap-3">
          <Logo name={settings['site.name']} size="sm" render={<NextLink href="/" />} />
          <p className="max-w-sm text-sm text-pretty text-text-muted">
            {settings['site.description'].trim() || home('description')}
          </p>
        </div>
        {COLUMNS.map((column) => (
          <nav key={column.key} aria-labelledby={`footer-${column.key}`} className="flex flex-col gap-3">
            <h2 id={`footer-${column.key}`} className="font-pixel text-pixel-1 text-text-muted">
              {t(`columns.${column.key}`)}
            </h2>
            <ul className="flex flex-col gap-2 text-sm">
              {column.links.map((link) => (
                <li key={link.key}>
                  <Link tone="quiet" render={<NextLink href={link.href} />}>
                    {t(`links.${link.key}`)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
        <div className="flex flex-col gap-2 border-t border-border pt-6 text-sm text-text-muted col-span-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6 lg:col-span-4">
          {custom ? (
            <Markdown>{custom.replaceAll('{year}', year)}</Markdown>
          ) : (
            <p>{t('copyright', { year, name: settings['site.name'] })}</p>
          )}
          <p className="shrink-0">{t('poweredBy')}</p>
        </div>
      </div>
    </footer>
  )
}
