import { cx } from '../cx.ts'

export interface LogoProps {
  /** 站点名，取自站点设置 */
  name: string
  /** 每格 6px（后台侧栏、页脚）或 8px（页头） */
  size?: 'sm' | 'md'
}

const sizes = {
  sm: { mark: 'w-6 h-3', name: 'text-pixel-1', gap: 'gap-2' },
  md: { mark: 'w-8 h-4', name: 'text-pixel-2', gap: 'gap-3' },
}

/**
 * 标志：皮肤材质里头部六个面的展开图，上一行是顶和底，下一行是右、前、左、后（DESIGN.md §2.2）。
 * 只有前脸用强调色
 */
export function Logo({ name, size = 'md' }: LogoProps) {
  const style = sizes[size]
  return (
    <span className={cx('inline-flex items-center', style.gap)}>
      <span aria-hidden className={cx('grid shrink-0 grid-cols-4 grid-rows-2', style.mark)}>
        <span className="col-start-2 row-start-1 bg-text" />
        <span className="col-start-3 row-start-1 bg-text-muted" />
        <span className="col-start-1 row-start-2 bg-border-strong" />
        <span className="col-start-2 row-start-2 bg-accent" />
        <span className="col-start-3 row-start-2 bg-border-strong" />
        <span className="col-start-4 row-start-2 bg-text-muted" />
      </span>
      <span className={cx('font-pixel text-text', style.name)}>{name}</span>
    </span>
  )
}
