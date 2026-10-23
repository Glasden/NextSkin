import { Check } from 'pixelarticons/react/Check.js'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import { LogoMark } from '../logo/logo-mark.tsx'

/**
 * 一种模式下的小样：缩小的页头、卡片、徽标和按钮，全部用 token 画（ADR-0057）。根元素带 data-theme 和 data-mode，
 * 颜色来自页面输出的那套主题的 CSS（限定在 [data-theme='<id>'] 上，钻石青也要输出），不随页面自己的主题和亮暗。
 * 不用 dark: 变体：它看的是祖先的 data-mode，暗色页面里的亮色小样会画错
 */
function ThemePreview({ theme, mode }: { theme: string; mode: 'light' | 'dark' }) {
  // 放在单选按钮（span）里，所以全用 span
  return (
    <span
      data-theme={theme}
      data-mode={mode}
      aria-hidden
      className="flex h-28 min-w-0 flex-col overflow-hidden rounded-sm border border-border bg-bg"
    >
      {/* 页头：标志、导航（当前项是强调色淡底）、右边的头像 */}
      <span className="flex h-6 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-1.5">
        <LogoMark cell={2} />
        <span className="ml-1 h-1 w-5 bg-text-muted" />
        <span className="flex h-3.5 items-center bg-accent-subtle px-1">
          <span className="h-1 w-4 bg-accent" />
        </span>
        <span className="ml-auto size-3 rounded-sm border border-border-strong bg-surface-sunken" />
      </span>
      <span className="flex min-h-0 flex-1 gap-1.5 p-1.5">
        {/* 卡片：标题、说明和成功色的徽标。圆角、边框粗细和静止时的阴影跟着这套主题的结构（ADR-0058） */}
        <span className="flex min-w-0 flex-1 flex-col gap-1 rounded-sm border border-border bg-surface p-1.5 shadow-(--card-shadow)">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-8 bg-text" />
            <span className="h-2.5 w-4 border border-success" />
          </span>
          <span className="h-1 w-full max-w-12 bg-text-muted" />
          <span className="h-1 w-3/4 max-w-9 bg-text-muted" />
          {/* 按钮：主要按钮是强调色的色块，带硬边阴影，旁边是危险操作 */}
          <span className="mt-auto flex items-center gap-1">
            <span className="flex h-3.5 w-9 items-center justify-center bg-accent-fill shadow-[1px_1px_0_0_var(--color-shadow)]">
              <span className="h-0.5 w-4 bg-accent-fill-fg" />
            </span>
            <span className="flex h-3.5 w-6 items-center justify-center bg-danger">
              <span className="h-0.5 w-2.5 bg-danger-fg" />
            </span>
          </span>
        </span>
        {/* 展台：锁住的中间调，任何主题下都一样 */}
        <span className="flex w-8 shrink-0 items-end justify-center rounded-sm bg-stage pb-1.5">
          <span className="h-9 w-3 bg-text-muted" />
        </span>
      </span>
    </span>
  )
}

/** 亮暗两份小样并排，ThemeCard 和 ThemePicker 共用 */
export function ThemePreviews({ theme }: { theme: string }) {
  return (
    <span className="grid grid-cols-2 gap-2 border-b border-border bg-surface-sunken p-2">
      <ThemePreview theme={theme} mode="light" />
      <ThemePreview theme={theme} mode="dark" />
    </span>
  )
}

// 选中：向内再画一圈描边，叠成常规边框两倍粗的强调色边，布局不跳动，同 TextureCard。名字前面的方框打勾，
// 不只靠颜色区分（DESIGN.md §2.1）。勾不放在左上角：那里是小样的标志
const selectedClass = 'border-accent outline-selected -outline-offset-(--outline-width-selected) outline-accent'

// 方框和 PlayerPicker 的一样：24px，勾是 24px 网格的图标，和方框的外沿对齐。ThemePicker 也用
export const boxClass = 'relative size-6 shrink-0 rounded-sm border-2'
const checkedBoxClass = 'border-accent bg-accent text-accent-fg'

export interface ThemeCardProps {
  /** 主题 id，写在小样的 data-theme 上；页面要输出这套主题的 CSS */
  theme: string
  /** 主题名 */
  name: string
  headingLevel?: 'h2' | 'h3'
  /** 名字下面一行，例如来源“内置”或插件名 */
  description?: ReactNode
  /** 跟在名字后面的状态，例如“默认”的 Badge */
  badge?: ReactNode
  /** 选中时的说明，例如“站点默认”。传了就加粗强调色边框、名字前面的方框打勾 */
  selected?: string
  /** 底部一行的操作，例如“启用”的 Switch 和“设为默认” */
  actions?: ReactNode
}

/**
 * 一套配色主题：上面是亮暗两份小样，下面是名字和来源，底部是操作（后台的主题页）。
 * 让用户挑一套改用 ThemePicker
 */
export function ThemeCard({
  theme,
  name,
  headingLevel: Heading = 'h2',
  description,
  badge,
  selected,
  actions,
}: ThemeCardProps) {
  return (
    <article
      className={cx(
        'relative flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-surface shadow-(--card-shadow)',
        selected && selectedClass,
      )}
    >
      <ThemePreviews theme={theme} />
      <div className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2">
        {selected && (
          <span className={cx(boxClass, checkedBoxClass, 'mt-0.5')}>
            <Check aria-hidden className="absolute -inset-0.5" />
            <span className="sr-only">{selected}</span>
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <Heading className="min-w-0 truncate text-base font-medium text-text">{name}</Heading>
            {badge}
          </div>
          {description && <div className="min-w-0 truncate text-sm text-text-muted">{description}</div>}
        </div>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-3 py-2">{actions}</div>
      )}
    </article>
  )
}
