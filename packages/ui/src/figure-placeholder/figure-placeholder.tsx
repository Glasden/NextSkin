import { poseLayout, poseSilhouette, type PoseView } from '@nextskin/skin'
import { cx } from '../cx.ts'

export interface FigurePlaceholderProps {
  /** 与同一位置的 SkinFigure 相同：一个标准像素显示成多少 CSS 像素 */
  scale: 3 | 4 | 5 | 8
  /** 与同一位置的 SkinFigure 相同：both 是背面和正面两个人影，front 一个 */
  view?: PoseView
  /** 替代文字，例如“Steve 还没有皮肤” */
  label: string
}

// 剪影和网格线、脚下投影一样由 text 混入 stage 得到（DESIGN.md §2.2），比投影浅，看得出是空的。
// 顶面最浅、侧面最深，和 3D 出图的明暗方向一致
const tones = [
  'fill-[color-mix(in_srgb,var(--color-text)_5%,var(--color-stage))]',
  'fill-[color-mix(in_srgb,var(--color-text)_7%,var(--color-stage))]',
  'fill-[color-mix(in_srgb,var(--color-text)_10%,var(--color-stage))]',
]
const tone = (shade: number) => tones[shade > 0.95 ? 0 : shade > 0.8 ? 1 : 2]
const shadowFill = 'fill-[color-mix(in_srgb,var(--color-text)_16%,var(--color-stage))]'

/**
 * 还没有皮肤时，在展台上代替 SkinFigure 的人形剪影：经典模型站着的样子，尺寸与 SkinFigure 相同。
 * 不用 Steve 和 Alex：它们是 Mojang 的材质（packages/skin/assets/README.md）
 */
export function FigurePlaceholder({ scale, view = 'both', label }: FigurePlaceholderProps) {
  const layout = poseLayout(view)
  const { box } = layout
  return (
    <span
      role="img"
      aria-label={label}
      className="relative inline-block shrink-0"
      style={{ width: box.width * scale, height: box.height * scale }}
    >
      <svg
        aria-hidden
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        shapeRendering="crispEdges"
        className="absolute"
        style={{
          left: -box.x * scale,
          top: -box.y * scale,
          width: layout.width * scale,
          height: layout.height * scale,
        }}
      >
        {layout.shadows.map((points) => (
          <polygon key={points.join()} points={points.join(' ')} className={shadowFill} />
        ))}
        {poseSilhouette(view).map(({ points, shade }) => (
          <polygon key={points.join()} points={points.join(' ')} className={cx(tone(shade))} />
        ))}
      </svg>
    </span>
  )
}
