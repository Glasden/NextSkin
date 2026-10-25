'use client'

import { Combobox } from '@base-ui/react/combobox'
import { Check } from 'pixelarticons/react/Check.js'
import { Search } from 'pixelarticons/react/Search.js'
import { useRef, useState, type ReactNode } from 'react'
import { cx } from '../cx.ts'
import { LoadingDots } from '../loading-dots.tsx'
import { focusRing } from '../styles.ts'

export interface MultiComboboxProps<Item> {
  /** 已选的项，按选中的先后排成输入框下方的小卡片 */
  value: readonly Item[]
  onValueChange: (value: Item[]) => void
  /**
   * 下拉里的候选项。不传 inputValue 时在本地按 itemLabel 过滤；传了就是远程搜索，
   * items 换成这次搜索的结果，组件不再过滤
   */
  items: readonly Item[]
  /** 每一项的唯一键，例如 uid。判断选没选中按它比，表单提交的也是它 */
  itemKey: (item: Item) => string
  /** 一项的名字：本地过滤比的、读屏读的、小卡片默认显示的都是它 */
  itemLabel: (item: Item) => string
  /** 下拉里一行的内容，默认是 itemLabel。用户可以放 24px 的 PlayerHead、昵称和一行编号 */
  renderItem?: (item: Item) => ReactNode
  /** 小卡片的内容，默认是 itemLabel。高 32px，放得下 24px 的 PlayerHead 加名字 */
  renderChip?: (item: Item) => ReactNode
  /** 输入框的文字，受控时同时传 onInputValueChange；用它发请求，结果交给 items。选中一项后组件把它清空 */
  inputValue?: string
  onInputValueChange?: (value: string) => void
  /** 正在搜索：下拉顶上显示 loadingLabel 和三个依次亮起的方块。这时一般不给旧结果，免得回车选中和输入不相干的项 */
  loading?: boolean
  loadingLabel?: string
  /** 输入框是空的、下拉里也没有候选项时的提示，例如“输入 uid、昵称或邮箱” */
  hintLabel?: string
  /** 输入了文字但没有匹配的项，例如“没有找到这个用户” */
  emptyLabel: string
  /** 小卡片上移除按钮的名称，例如 (label) => `移除 ${label}` */
  removeLabel: (label: string) => string
  /** 最多选几个。设了就在输入框右边显示“已选 / 上限”，同 Textarea 的字数；选满后其余候选项不能再选 */
  max?: number
  placeholder?: string
  /** 表单提交时的字段名，每个已选项提交一个 itemKey */
  name?: string
  disabled?: boolean
  required?: boolean
  /** 不放在 Field 里时必须提供 */
  'aria-label'?: string
}

// 和 Input 的 md 相同，左边让出搜索图标的位置
const inputClass = cx(
  'h-10 w-full min-w-0 rounded-sm border border-border-strong bg-surface pl-10 font-sans text-base text-text placeholder:text-text-muted',
  'data-invalid:border-danger',
  'data-disabled:cursor-not-allowed data-disabled:border-border data-disabled:bg-surface-sunken data-disabled:text-text-muted',
  focusRing,
)

// 已选的项是强调色的淡底（theme.css：筛选标签），和 Badge 的状态、Button 的操作区分开
const chipClass = cx(
  'inline-flex h-8 max-w-full min-w-0 items-center gap-1 rounded-sm border border-accent bg-accent-subtle pr-0.5 pl-2 text-sm text-text outline-none',
  'data-disabled:border-border data-disabled:bg-surface-sunken data-disabled:text-text-muted',
  focusRing,
)

// 悬停底色混入 12% 的 text（DESIGN.md §2）。× 用像素字体 12px 的字形，比缩小的图标清楚（DESIGN.md §4）。
// 移动端把点击区域扩到 40px：再大就盖到旁边的小卡片上
const removeClass = cx(
  'relative grid size-6 shrink-0 place-items-center rounded-sm font-pixel text-pixel-1 text-text-muted',
  'hover:bg-[color-mix(in_srgb,var(--color-accent-subtle)_88%,var(--color-text))] hover:text-text',
  'data-disabled:cursor-not-allowed data-disabled:hover:bg-transparent data-disabled:hover:text-text-muted',
  'pointer-coarse:after:absolute pointer-coarse:after:-inset-2',
)

const itemClass = cx(
  'grid min-h-10 cursor-default grid-cols-[24px_1fr] items-center gap-2 py-1 pr-3 pl-2 text-base text-text outline-none select-none',
  'data-highlighted:bg-[color-mix(in_srgb,var(--color-surface-raised)_88%,var(--color-text))]',
  'data-disabled:cursor-not-allowed data-disabled:text-text-muted',
)

/**
 * 搜索并选出多项，例如后台发通知时挑几个收件人。上面是带搜索图标的输入框，打字时下拉列出匹配的项，
 * 已选的打勾、再点一次取消；选中的排成输入框下方的小卡片，点 × 移除。宽度占满父元素。
 *
 * 键盘：打字后第一项自动高亮，回车选中它，所以输入 uid 加回车就能连着选。输入框里有字、还没有高亮项
 * （结果还没到）时回车什么也不做：不提交表单，提交的会少一项；也不关下拉。输入框为空时退格删掉最后一张小卡片，光标在开头时左方向键移到小卡片上，
 * 左右切换，退格或 Delete 删掉。下拉关着时按 Esc 不清空已选（Base UI 默认会清空，一串收件人一下就没了）
 */
export function MultiCombobox<Item>({
  value,
  onValueChange,
  items,
  itemKey,
  itemLabel,
  renderItem = itemLabel,
  renderChip = itemLabel,
  inputValue,
  onInputValueChange,
  loading = false,
  loadingLabel,
  hintLabel,
  emptyLabel,
  removeLabel,
  max,
  placeholder,
  name,
  disabled,
  required,
  'aria-label': ariaLabel,
}: MultiComboboxProps<Item>) {
  const groupRef = useRef<HTMLDivElement>(null)
  const highlighted = useRef(false)
  const [open, setOpen] = useState(false)
  // 非受控时自己记一份，用来区分“还没输入”和“没有匹配”
  const [typed, setTyped] = useState('')
  const query = inputValue ?? typed
  const full = max !== undefined && value.length >= max
  const selected = new Set(value.map(itemKey))
  return (
    <Combobox.Root<Item, true>
      multiple
      autoHighlight
      items={items}
      value={value}
      onValueChange={(next) => {
        if (max === undefined || next.length <= max) onValueChange(next)
      }}
      // 远程搜索：结果已经是服务端筛过的
      filter={inputValue === undefined ? undefined : null}
      inputValue={inputValue}
      onInputValueChange={(next) => {
        setTyped(next)
        onInputValueChange?.(next)
      }}
      onOpenChange={setOpen}
      onItemHighlighted={(item) => {
        highlighted.current = item !== undefined
      }}
      itemToStringLabel={itemLabel}
      itemToStringValue={itemKey}
      isItemEqualToValue={(a, b) => itemKey(a) === itemKey(b)}
      name={name}
      disabled={disabled}
      required={required}
    >
      <Combobox.Chips
        className="flex flex-col gap-2"
        onMouseDown={(event) => {
          // 点输入框之外（小卡片那一行的空白）不打开下拉
          if (!groupRef.current?.contains(event.target as Node)) event.preventBaseUIHandler()
        }}
      >
        <Combobox.InputGroup ref={groupRef} className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-2 left-2 text-text-muted" />
          <Combobox.Input
            aria-label={ariaLabel}
            placeholder={placeholder}
            // 给右边的计数留出位置
            className={cx(inputClass, max === undefined ? 'pr-3' : 'pr-16')}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !open) event.preventBaseUIHandler()
              if (event.key === 'Enter' && query.trim() && !highlighted.current) {
                event.preventDefault()
                event.preventBaseUIHandler()
              }
            }}
          />
          {max !== undefined && (
            <span
              aria-hidden
              className="pointer-events-none absolute top-3 right-3 font-pixel text-pixel-1 text-text-muted tabular-nums"
            >
              {`${value.length} / ${max}`}
            </span>
          )}
        </Combobox.InputGroup>
        {value.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {value.map((item) => (
              <Combobox.Chip key={itemKey(item)} className={chipClass}>
                <span className="flex min-w-0 items-center gap-1.5 truncate">{renderChip(item)}</span>
                <Combobox.ChipRemove aria-label={removeLabel(itemLabel(item))} className={removeClass}>
                  <span aria-hidden>×</span>
                </Combobox.ChipRemove>
              </Combobox.Chip>
            ))}
          </div>
        )}
      </Combobox.Chips>
      <Combobox.Portal>
        <Combobox.Positioner className="z-50 outline-none" sideOffset={4} collisionPadding={16}>
          <Combobox.Popup
            className={cx(
              // 渲染在 body 下，字体自己设。弹出是四格阶跃的淡入，同 Select
              'w-(--anchor-width) rounded-md border border-border-strong bg-surface-raised font-sans text-text shadow-pixel-lg outline-none',
              'transition-opacity duration-fast ease-step motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0',
            )}
          >
            {/* 两个提示区一直挂着，读屏才读得出内容的变化（Base UI 要求不能 display: none）；没有内容时不占高度 */}
            <Combobox.Status className="flex items-center gap-2 px-3 py-2 text-sm text-text-muted empty:p-0">
              {loading && (
                <>
                  {loadingLabel}
                  <LoadingDots />
                </>
              )}
            </Combobox.Status>
            <Combobox.Empty className="px-3 py-2 text-sm text-text-muted empty:p-0">
              {!loading && (query.trim() ? emptyLabel : hintLabel)}
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(var(--available-height),20rem)] overflow-y-auto py-1 empty:p-0">
              {(item: Item) => (
                <Combobox.Item
                  key={itemKey(item)}
                  value={item}
                  disabled={full && !selected.has(itemKey(item))}
                  className={itemClass}
                >
                  {/* 已选的打勾，不只靠字重区分（DESIGN.md §2.1） */}
                  <Combobox.ItemIndicator className="col-start-1 flex text-accent">
                    <Check aria-hidden />
                  </Combobox.ItemIndicator>
                  <span className="col-start-2 flex min-w-0 items-center gap-2">{renderItem(item)}</span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
