import { Check } from 'pixelarticons/react/Check.js'
import type { ReactNode } from 'react'
import { cx } from '../cx.ts'

export interface StepsItem {
  label: string
  /** 竖排时显示在标签下方，例如已处理的行数、当前阶段的进度条；横排时不显示 */
  description?: ReactNode
}

export interface StepsProps {
  /** 读屏软件用的名称，例如“导入步骤” */
  label: string
  items: readonly StepsItem[]
  /** 当前步骤的下标，从 0 开始；之前的都算完成，等于 items.length 时全部完成 */
  current: number
  /** 已完成的步骤后面给读屏软件读的状态，例如“已完成”。完成的步骤用勾号代替序号，不只靠颜色区分（DESIGN.md §9） */
  completeLabel: string
  /**
   * horizontal：向导顶部的步骤条，容器窄于 576px 时收成“当前步骤 + 一排小方块”；
   * vertical：带说明的阶段列表，例如导入的进度
   */
  orientation?: 'horizontal' | 'vertical'
}

type StepState = 'complete' | 'current' | 'upcoming'

const boxes: Record<StepState, string> = {
  complete: 'border-border-strong bg-surface text-text',
  current: 'border-transparent bg-accent-fill text-accent-fill-fg shadow-pixel',
  upcoming: 'border-border bg-surface text-text-muted',
}

// 连接线：走过的是实线，没走到的是 4px 一段的虚线
const lines = {
  done: 'bg-border-strong',
  todo: {
    horizontal: 'bg-[repeating-linear-gradient(to_right,var(--color-border)_0_4px,transparent_4px_8px)]',
    vertical: 'bg-[repeating-linear-gradient(to_bottom,var(--color-border)_0_4px,transparent_4px_8px)]',
  },
}

function stateOf(index: number, current: number): StepState {
  return index < current ? 'complete' : index === current ? 'current' : 'upcoming'
}

/** 步骤的方块：48px，像素字体 ×3 的序号（DESIGN.md §3），完成后换成勾号 */
function StepBox({ index, state }: { index: number; state: StepState }) {
  return (
    <span
      aria-hidden
      className={cx(
        'flex size-12 shrink-0 items-center justify-center rounded-sm border-2 font-pixel text-pixel-3 tabular-nums',
        boxes[state],
      )}
    >
      {state === 'complete' ? <Check /> : index + 1}
    </span>
  )
}

/**
 * 多步流程的进度，例如安装向导、导入。只表示走到了哪一步，不能点击跳转：回到上一步由页面上的按钮负责。
 * 一次只做一件事的单页表单不需要它
 */
export function Steps({ label, items, current, completeLabel, orientation = 'horizontal' }: StepsProps) {
  const vertical = orientation === 'vertical'
  const list = (
    <ol aria-label={label} className={vertical ? 'flex flex-col' : 'flex @max-xl:sr-only'}>
      {items.map((item, index) => {
        const state = stateOf(index, current)
        const status = state === 'complete' && <span className="sr-only">{`（${completeLabel}）`}</span>
        return (
          <li
            key={`${index}:${item.label}`}
            aria-current={state === 'current' ? 'step' : undefined}
            className={cx(
              'relative flex',
              vertical ? 'gap-4 pb-8 last:pb-0' : 'min-w-0 flex-1 flex-col items-center gap-2 text-center',
            )}
          >
            {/* 横排：从上一个方块的右边连到这个方块的左边；竖排：从这个方块下面连到下一项的方块上面。横排两头各留 8px，竖排各留 4px */}
            {!vertical && index > 0 && (
              <span
                aria-hidden
                className={cx(
                  'absolute top-[22px] right-[calc(50%+32px)] left-[calc(-50%+32px)] h-1',
                  index <= current ? lines.done : lines.todo.horizontal,
                )}
              />
            )}
            {vertical && index < items.length - 1 && (
              <span
                aria-hidden
                className={cx(
                  'absolute top-[52px] bottom-1 left-[22px] w-1',
                  index < current ? lines.done : lines.todo.vertical,
                )}
              />
            )}
            <StepBox index={index} state={state} />
            {/* 竖排时标签和方块的中线对齐 */}
            <div className={cx('flex min-w-0 flex-col gap-2', vertical && 'flex-1 pt-4')}>
              <span
                className={cx(
                  'font-pixel text-pixel-1 break-words',
                  state === 'upcoming' ? 'text-text-muted' : 'text-text',
                )}
              >
                {item.label}
                {status}
              </span>
              {vertical && item.description !== undefined && (
                <div className="text-sm text-text-muted">{item.description}</div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
  if (vertical) return list
  // 窄容器：只显示当前这一步，下面一排小方块表示走到了哪里。读屏软件读上面的列表
  const shown = Math.min(current, items.length - 1)
  return (
    <div className="@container">
      {list}
      <div aria-hidden className="flex flex-col gap-3 @xl:hidden">
        <div className="flex items-center gap-3">
          <StepBox index={shown} state={stateOf(shown, current)} />
          <span className="min-w-0 flex-1 font-pixel text-pixel-1 text-text">{items[shown]?.label}</span>
          <span className="shrink-0 font-pixel text-pixel-1 text-text-muted tabular-nums">
            {Math.min(current + 1, items.length)} / {items.length}
          </span>
        </div>
        <div className="flex gap-1">
          {items.map((item, index) => (
            <span
              key={`${index}:${item.label}`}
              className={cx(
                'h-1 flex-1',
                index < current ? 'bg-border-strong' : index === current ? 'bg-accent' : 'bg-border',
              )}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
