import { cx } from '../cx.ts'

export interface FigurePlaceholderProps {
  /** 与同一位置的 SkinFigure 相同：一个标准像素显示成多少 CSS 像素 */
  scale: 3 | 4 | 5 | 8
  /** 替代文字，例如“Steve 还没有皮肤” */
  label: string
}

// 正面的人形，按经典模型的 16×32 个标准像素：头、身体、两条手臂、两条腿
const parts = [
  [4, 0, 8, 8],
  [4, 8, 8, 12],
  [0, 8, 4, 12],
  [12, 8, 4, 12],
  [4, 20, 4, 12],
  [8, 20, 4, 12],
] as const

/**
 * 还没有皮肤时，在展台上代替 SkinFigure 的人形剪影，尺寸与皮肤的 2D 正面相同。
 * 不用 Steve 和 Alex：它们是 Mojang 的材质（packages/skin/assets/README.md）
 */
export function FigurePlaceholder({ scale, label }: FigurePlaceholderProps) {
  return (
    <span role="img" aria-label={label} className="relative inline-block shrink-0" style={{ width: 16 * scale }}>
      <svg
        aria-hidden
        viewBox="0 0 16 32"
        width={16 * scale}
        height={32 * scale}
        shapeRendering="crispEdges"
        className={cx(
          'block',
          // 剪影和网格线、脚下投影一样由 text 混入 stage 得到（DESIGN.md §2.2），比投影浅，看得出是空的
          'fill-[color-mix(in_srgb,var(--color-text)_10%,var(--color-stage))]',
          'stroke-[color-mix(in_srgb,var(--color-text)_24%,var(--color-stage))] [stroke-dasharray:1_1]',
        )}
      >
        {parts.map(([x, y, width, height]) => (
          <rect
            key={`${x},${y}`}
            x={x + 0.5 / scale}
            y={y + 0.5 / scale}
            width={width - 1 / scale}
            height={height - 1 / scale}
            strokeWidth={1 / scale}
          />
        ))}
      </svg>
      <span
        aria-hidden
        className="absolute left-1/2 -translate-x-1/2 bg-[color-mix(in_srgb,var(--color-text)_16%,var(--color-stage))]"
        style={{ width: 12 * scale, height: scale, bottom: -Math.ceil(scale / 2) }}
      />
    </span>
  )
}
