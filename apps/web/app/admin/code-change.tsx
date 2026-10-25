'use client'

import { Link, Panel, Sheet } from '@nextskin/ui'

/**
 * 审计里代码类设置的一次改动（ADR-0063：页头代码、自定义 CSS、ads.txt 记全文）。表格里只写长度，
 * 全文放在侧边栏里，改之前和改之后上下对照；值为 null 表示读不出来
 */
export function CodeChange({
  summary,
  title,
  from,
  to,
  texts,
}: {
  readonly summary: string
  readonly title: string
  readonly from: string | null
  readonly to: string
  readonly texts: { view: string; close: string; before: string; after: string; empty: string; unreadable: string }
}) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span>{summary}</span>
      <Sheet
        title={title}
        closeLabel={texts.close}
        trigger={<Link render={<button type="button" />}>{texts.view}</Link>}
      >
        <div className="flex flex-col gap-6">
          <CodeBlock heading={texts.before} value={from} texts={texts} />
          <CodeBlock heading={texts.after} value={to} texts={texts} />
        </div>
      </Sheet>
    </span>
  )
}

function CodeBlock({
  heading,
  value,
  texts,
}: {
  heading: string
  value: string | null
  texts: { empty: string; unreadable: string }
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-text">{heading}</h3>
      <Panel tone="sunken" padding="sm">
        {value ? (
          <pre className="font-mono text-sm break-all whitespace-pre-wrap text-text">{value}</pre>
        ) : (
          <p className="text-sm text-text-muted">{value === null ? texts.unreadable : texts.empty}</p>
        )}
      </Panel>
    </section>
  )
}
