import { ChevronLeft } from 'pixelarticons/react/ChevronLeft.js'
import { ChevronRight } from 'pixelarticons/react/ChevronRight.js'
import type { ElementType, ReactNode } from 'react'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

/** linkAs 收到的属性：框架的链接组件（例如 NextLink）都接受这些 */
export interface PaginationLinkProps {
  href: string
  className: string
  children: ReactNode
  'aria-label': string
  title?: string
}

export interface PaginationProps {
  /** 当前页，从 1 开始 */
  page: number
  pageCount: number
  /** 第几页的地址，例如 `(page) => '/skinlib?page=' + page` */
  href: (page: number) => string
  /** 渲染链接的组件。站内跳转传框架的链接组件，例如 NextLink；默认是 `<a>` */
  linkAs?: ElementType<PaginationLinkProps>
  /** 读屏软件用的名称，例如“皮肤库分页” */
  label: string
  /** “上一页”“下一页”：图标按钮的名称 */
  previousLabel: string
  nextLabel: string
  /** 页码链接的完整名称，例如“第 3 页” */
  pageLabel: (page: number) => string
}

const square = 'relative grid h-10 min-w-10 place-items-center rounded-sm px-2'
// 悬停是底色混入 12% 的 text（DESIGN.md §2）
const linkClass = cx(
  square,
  'font-pixel text-pixel-1 text-text tabular-nums hover:bg-[color-mix(in_srgb,var(--color-bg)_88%,var(--color-text))]',
  focusRing,
  // 移动端把点击区域扩到 44px（DESIGN.md §9）
  'pointer-coarse:after:absolute pointer-coarse:after:-inset-0.5',
)
// 当前页：强调色淡底加底边的色块，与 Nav 的当前项一致，不只靠颜色区分
const currentClass = cx(
  square,
  'bg-accent-subtle font-pixel text-pixel-1 text-accent tabular-nums',
  'after:absolute after:inset-x-2 after:bottom-0 after:h-1 after:bg-accent',
)

/** 要显示的页码：第一页、最后一页、当前页和它两边各一页，中间断开的地方是 null（省略号） */
export function pageWindow(page: number, pageCount: number): (number | null)[] {
  const pages = new Set([1, pageCount, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pageCount))
  // 只隔一页时直接显示那一页，省略号不比它短
  for (const p of [...pages]) if (pages.has(p + 2) && !pages.has(p + 1)) pages.add(p + 1)
  const sorted = [...pages].sort((a, b) => a - b)
  return sorted.flatMap((p, i) => (i > 0 && p - sorted[i - 1]! > 1 ? [null, p] : [p]))
}

/**
 * 列表的分页：上一页、页码、下一页，都是链接，不需要 JS。窄屏（md 以下）只显示“当前页 / 总页数”和两个箭头。
 * 只有一页时不渲染
 */
export function Pagination({
  page,
  pageCount,
  href,
  linkAs: LinkAs = 'a',
  label,
  previousLabel,
  nextLabel,
  pageLabel,
}: PaginationProps) {
  if (pageCount <= 1) return null
  const arrow = (target: number, name: string, icon: ReactNode) =>
    target >= 1 && target <= pageCount ? (
      <LinkAs
        href={href(target)}
        aria-label={name}
        title={name}
        className={cx(linkClass, 'text-text-muted hover:text-text')}
      >
        <span aria-hidden className="contents">
          {icon}
        </span>
      </LinkAs>
    ) : (
      // 第一页没有上一页：留着位置，不让页码左右跳
      <span aria-hidden className={cx(square, 'text-border-strong')}>
        {icon}
      </span>
    )
  return (
    <nav aria-label={label}>
      <ul className="flex items-center gap-1">
        <li>{arrow(page - 1, previousLabel, <ChevronLeft />)}</li>
        {pageWindow(page, pageCount).map((p, i) =>
          p === null ? (
            <li
              key={`gap-${i}`}
              aria-hidden
              className={cx(square, 'hidden font-pixel text-pixel-1 text-text-muted md:grid')}
            >
              …
            </li>
          ) : (
            <li key={p} className="hidden md:block">
              {p === page ? (
                <span aria-current="page" className={currentClass}>
                  <span className="sr-only">{pageLabel(p)}</span>
                  <span aria-hidden>{p}</span>
                </span>
              ) : (
                <LinkAs href={href(p)} aria-label={pageLabel(p)} className={linkClass}>
                  {p}
                </LinkAs>
              )}
            </li>
          ),
        )}
        <li className="px-2 font-pixel text-pixel-1 text-text tabular-nums md:hidden">
          <span className="sr-only">{pageLabel(page)}</span>
          <span aria-hidden>
            {page} / {pageCount}
          </span>
        </li>
        <li>{arrow(page + 1, nextLabel, <ChevronRight />)}</li>
      </ul>
    </nav>
  )
}
