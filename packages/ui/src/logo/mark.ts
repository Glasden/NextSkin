/**
 * 标志的图形：折起来的头（DESIGN.md §2.2、ADR-0032）。8×8 的网格，一个字符一格：
 * a 前脸、f 眼睛、m 顶面、s 右侧面、. 透明。Logo 组件和 favicon 的生成脚本共用这一份
 */
export const LOGO_MARK = [
  '..mmmmmm',
  '.mmmmmms',
  'aaaaaass',
  'aaaaaass',
  'afaafass',
  'afaafass',
  'aaaaaass',
  'aaaaaas.',
] as const

export const LOGO_MARK_SIZE = LOGO_MARK.length

/** 每种格子用的颜色 token。前脸是强调色的色块（ADR-0058）：高对比的亮色下表面上的强调色是黑色，标志仍是荧光色 */
export const LOGO_MARK_COLORS = {
  a: 'accent-fill',
  f: 'accent-fill-fg',
  m: 'text-muted',
  s: 'border-strong',
} as const

export type LogoMarkColor = (typeof LOGO_MARK_COLORS)[keyof typeof LOGO_MARK_COLORS]

export interface LogoMarkRect {
  x: number
  y: number
  width: number
  color: LogoMarkColor
}

/** 同一行里同色的连续格子合成一个矩形，SVG 里的元素少一些 */
export function logoMarkRects(): LogoMarkRect[] {
  const rects: LogoMarkRect[] = []
  LOGO_MARK.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const cell = row[x]!
      let end = x + 1
      while (row[end] === cell) end++
      if (cell !== '.')
        rects.push({ x, y, width: end - x, color: LOGO_MARK_COLORS[cell as keyof typeof LOGO_MARK_COLORS] })
      x = end
    }
  })
  return rects
}
