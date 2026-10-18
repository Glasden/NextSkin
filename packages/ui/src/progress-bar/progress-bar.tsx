import { cx } from '../cx.ts'

export interface ProgressBarProps {
  /** 显示在进度条上方，也是读屏软件读到的名称，例如“用户” */
  label: string
  /** 当前进度；null 表示进度未知，方块循环亮起 */
  value: number | null
  /** 默认 100 */
  max?: number
  /** 显示在右上角的进度文字，例如“1,234 / 5,000 行”；也作为 aria-valuetext。不传时读屏软件读百分比 */
  valueText?: string
}

/** 方块数固定：进度按格前进，每格 5%（阶跃，DESIGN.md §2） */
const SEGMENTS = 20

/**
 * 进度条：一排方块按进度点亮，不是连续的色条。用于耗时的后台任务，例如导入；按钮上的提交中用 Button 的 `loading`。
 * 进度未知时全部方块半亮，一组亮块从左走到右；开启“减少动态效果”时停在全部半亮
 */
export function ProgressBar({ label, value, max = 100, valueText }: ProgressBarProps) {
  const known = value !== null && max > 0
  const ratio = known ? Math.min(Math.max(value / max, 0), 1) : 0
  // 向下取整：没有做完就不亮满最后一格
  const lit = Math.floor(ratio * SEGMENTS)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? max : undefined}
      aria-valuenow={known ? Math.min(Math.max(value, 0), max) : undefined}
      aria-valuetext={valueText}
      className="flex flex-col gap-1.5"
    >
      <div aria-hidden className="flex items-baseline justify-between gap-4 text-sm">
        <span className="min-w-0 truncate text-text">{label}</span>
        {valueText && <span className="shrink-0 text-text-muted tabular-nums">{valueText}</span>}
      </div>
      <div aria-hidden className="flex h-4 gap-1 rounded-sm border-2 border-border-strong bg-surface-sunken p-0.5">
        {Array.from({ length: SEGMENTS }, (_, index) => (
          <span
            key={index}
            className={cx(
              'h-full min-w-0 flex-1',
              known ? index < lit && 'bg-accent' : 'bg-accent opacity-30 animate-progress motion-reduce:animate-none',
            )}
            // 依次错开，一组三格的亮块从左走到右
            style={known ? undefined : { animationDelay: `${(index - SEGMENTS) * 60}ms` }}
          />
        ))}
      </div>
    </div>
  )
}
