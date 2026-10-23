import { cx, Link, Markdown, Panel } from '@nextskin/ui'
import { getFormatter, getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import type { PluginWidget } from '../../lib/plugins'

// 一行几格：首页上的统计最多 4 项（WIDGET_STATS_LIMIT）。占满一行的挂件放得下 4 格，半行的 4 项排成两行
const statColumns = {
  narrow: ['grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-2'],
  wide: ['grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-2 sm:grid-cols-4'],
} as const

/**
 * 插件放在首页上的挂件（ADR-0059，DESIGN.md §11）：大屏两列、窄屏一列，个数是奇数时最后一个占满一行。
 * 每个挂件一个区块：像素字的二级标题、右边链到插件页面，下面一块 Panel。没有挂件时什么也不渲染。
 * mutedHeadings：标题用次要文字色，和后台概览上其他区块的标题一样
 */
export async function PluginWidgets({
  widgets,
  mutedHeadings = false,
}: {
  widgets: PluginWidget[]
  mutedHeadings?: boolean
}) {
  if (!widgets.length) return null
  const [t, format] = await Promise.all([getTranslations('pluginView'), getFormatter()])
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {widgets.map((widget, index) => {
        const wide = widgets.length % 2 === 1 && index === widgets.length - 1
        const headingId = `widget-${widget.key.replace('/', '--')}`
        const { content } = widget
        return (
          <section
            key={widget.key}
            aria-labelledby={headingId}
            className={cx('flex min-w-0 flex-col gap-3', wide && 'lg:col-span-2')}
          >
            <div className="flex items-center justify-between gap-4">
              <h2
                id={headingId}
                className={cx('font-pixel text-pixel-1', mutedHeadings ? 'text-text-muted' : 'text-text')}
              >
                {widget.title}
              </h2>
              {widget.link && (
                <span className="text-sm">
                  <Link render={<NextLink href={widget.link.href} />}>{widget.link.label}</Link>
                </span>
              )}
            </div>
            <Panel grow>
              {!content ? (
                <p className="text-sm text-text-muted">{t('widgetLoadFailed')}</p>
              ) : content.kind === 'markdown' ? (
                content.text.trim() ? (
                  // 挂件的标题是二级，插件写的 `#` 从三级开始；代码块多半是要复制走的链接或命令
                  <Markdown copy={{ label: t('copyCode'), done: t('codeCopied'), failed: t('copyCodeFailed') }}>
                    {content.text}
                  </Markdown>
                ) : (
                  <p className="text-sm text-text-muted">{t('empty')}</p>
                )
              ) : content.items.length ? (
                <dl
                  className={cx(
                    'grid gap-x-6 gap-y-4',
                    statColumns[wide ? 'wide' : 'narrow'][Math.min(content.items.length, 4) - 1],
                  )}
                >
                  {content.items.map((item, i) => (
                    <div key={i} className="flex min-w-0 flex-col gap-1">
                      <dt className="text-sm text-text-muted">{item.label}</dt>
                      <dd className="font-pixel text-pixel-2 text-text tabular-nums">
                        {typeof item.value === 'number' ? format.number(item.value) : item.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-sm text-text-muted">{t('empty')}</p>
              )}
            </Panel>
          </section>
        )
      })}
    </div>
  )
}
