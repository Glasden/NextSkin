import { LOGO_MARK_SIZE, logoMarkRects, type LogoMarkColor } from './mark.ts'

const fills: Record<LogoMarkColor, string> = {
  accent: 'fill-accent',
  'accent-fg': 'fill-accent-fg',
  'text-muted': 'fill-text-muted',
  'border-strong': 'fill-border-strong',
}

const rects = logoMarkRects()

/**
 * 内置的像素图形，每格 cell 像素。站点设置里的图片控件拿它当没有上传时的预览，
 * 还没设头像的用户也显示它（PlayerHead）。不是客户端组件，服务端组件能直接用
 */
export function LogoMark({ cell }: { cell: number }) {
  const px = LOGO_MARK_SIZE * cell
  return (
    <svg
      aria-hidden
      width={px}
      height={px}
      viewBox={`0 0 ${LOGO_MARK_SIZE} ${LOGO_MARK_SIZE}`}
      shapeRendering="crispEdges"
      className="block shrink-0"
    >
      {rects.map((rect) => (
        <rect
          key={`${rect.x},${rect.y}`}
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={1}
          className={fills[rect.color]}
        />
      ))}
    </svg>
  )
}
