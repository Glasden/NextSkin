import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import { stageGrid } from '../styles.ts'

export interface StageProps {
  /** 一般是 SkinFigure 或 3D 预览，居中摆放 */
  children: ReactNode
  /** 大展台（3D 预览、领奖台、登录页插图）加 16px 网格，×4 时正好 4 个材质像素一格（DESIGN.md §2.2） */
  grid?: boolean
}

/**
 * 摆放材质的展台。底色在亮暗两种模式下都是中间调，深色和浅色皮肤都看得清（DESIGN.md §10）。
 * 占满父元素，尺寸由父元素决定
 */
export function Stage({ children, grid = false }: StageProps) {
  return (
    <div
      className={cx('grid size-full place-items-center rounded-md border border-border bg-stage', grid && stageGrid)}
    >
      {children}
    </div>
  )
}
