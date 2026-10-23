'use client'

import { Tabs as BaseTabs } from '@base-ui/react/tabs'
import { useState, type ReactNode } from 'react'
import { cx } from '../cx.ts'
import { Select } from '../select/select.tsx'
import { focusRing } from '../styles.ts'

export interface TabsItem<Value extends string> {
  value: Value
  label: string
  /** 跟在标签后面的数量，例如衣柜里有几件皮肤。数到上限就不再往下数时传写好的文字，例如“99+” */
  count?: number | string
  disabled?: boolean
}

export interface TabsProps<Value extends string> {
  items: readonly TabsItem<Value>[]
  /** 当前标签页。按地址切换的页面（例如衣柜）用受控的 value，在 onValueChange 里跳转 */
  value?: Value
  defaultValue?: Value
  onValueChange?: (value: Value) => void
  /** 标签组的名称，例如“衣柜分类” */
  'aria-label': string
  /**
   * 标签多、窄的容器里一行放不下时（容器窄于 42rem）换成一个 Select，例如后台设置的九个分区。
   * 不开时放不下就横向滚动；两三个标签的不用开
   */
  collapse?: boolean
  /** 当前标签页的内容。只渲染当前这一页：别的页通常要换了地址才查出来 */
  children: ReactNode
}

// 悬停是底色混入 12% 的 text（DESIGN.md §2）；当前项不变底色，靠文字颜色和底边的色块区分
const tabClass = cx(
  'relative flex h-10 shrink-0 items-center gap-2 rounded-t-sm px-3 font-pixel text-pixel-1 whitespace-nowrap text-text-muted select-none',
  'hover:bg-[color-mix(in_srgb,var(--color-bg)_88%,var(--color-text))] hover:text-text',
  'data-active:text-text data-active:hover:bg-transparent',
  'data-disabled:cursor-not-allowed data-disabled:text-border-strong data-disabled:hover:bg-transparent',
  focusRing,
  // 窄屏把点击区域扩到 44px（DESIGN.md §9）
  'pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-0.5',
)

/**
 * 页面里的分组切换，例如衣柜的皮肤和披风。标签排成一行，当前项的底边是一条 4px 的强调色色块，
 * 切换时一格一格地挪过去（DESIGN.md §2），减少动态效果时直接跳过去。放不下时横向滚动，开了 collapse 换成 Select。
 * 方向键在标签之间移动，Enter 或空格切换
 */
export function Tabs<Value extends string>({
  items,
  value,
  defaultValue,
  onValueChange,
  'aria-label': ariaLabel,
  collapse = false,
  children,
}: TabsProps<Value>) {
  // 标签和窄屏的 Select 共用一个当前值：不受控时也由这里记着
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? items[0]?.value)
  const current = value ?? uncontrolled
  const change = (next: Value) => {
    setUncontrolled(next)
    onValueChange?.(next)
  }
  return (
    <BaseTabs.Root
      value={current}
      onValueChange={(next: Value) => change(next)}
      className={cx('flex min-w-0 flex-col gap-6', collapse && '@container')}
    >
      {collapse && (
        <div className="@2xl:hidden">
          <Select
            aria-label={ariaLabel}
            options={items
              .filter((item) => !item.disabled)
              .map((item) => ({
                value: item.value,
                label: item.count === undefined ? item.label : `${item.label} ${item.count}`,
              }))}
            value={current}
            onValueChange={change}
          />
        </div>
      )}
      {/* 滚动容器会裁掉超出的部分：四周留出焦点框的 4px（2px 间距加 2px 描边），再用负外边距抵消 */}
      <div className={cx('-mx-4 -my-1 overflow-x-auto px-4 py-1 sm:-mx-1 sm:px-1', collapse && 'hidden @2xl:block')}>
        <BaseTabs.List aria-label={ariaLabel} className="relative flex min-w-fit gap-1 border-b border-border">
          {items.map((item) => (
            <BaseTabs.Tab key={item.value} value={item.value} disabled={item.disabled} className={tabClass}>
              {item.label}
              {item.count !== undefined && <span className="text-text-muted tabular-nums">{item.count}</span>}
            </BaseTabs.Tab>
          ))}
          {/* 指示条压住列表的底边：往下挪一个常规边框的粗细，边框随主题的结构变粗时跟着挪（ADR-0058） */}
          <BaseTabs.Indicator
            renderBeforeHydration
            className={cx(
              'absolute -bottom-(--border-width-base) left-0 h-1 w-(--active-tab-width) translate-x-(--active-tab-left) bg-accent',
              'transition-[translate,width] duration-slow ease-step motion-reduce:transition-none',
            )}
          />
        </BaseTabs.List>
      </div>
      <BaseTabs.Panel value={current} className={cx('min-w-0', focusRing)}>
        {children}
      </BaseTabs.Panel>
    </BaseTabs.Root>
  )
}
