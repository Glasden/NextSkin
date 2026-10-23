import type { HexColor } from './names.ts'

const HEX = /^#[\da-f]{6}$/i

/** `#rrggbb`，不分大小写。不收三位、八位、颜色函数和带空白的写法：生成的 CSS 里只出现检查过的色值 */
export function isHexColor(value: unknown): value is HexColor {
  return typeof value === 'string' && value.length === 7 && HEX.test(value)
}

function channels(color: string): [number, number, number] {
  if (!isHexColor(color)) throw new Error(`颜色必须是 #rrggbb：${color}`)
  return [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16)) as [number, number, number]
}

/** sRGB 的 0–255 转成线性值 */
function linear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** WCAG 2 的相对亮度 */
export function relativeLuminance(color: string): number {
  const [r, g, b] = channels(color).map(linear) as [number, number, number]
  return r * 0.2126 + g * 0.7152 + b * 0.0722
}

/** WCAG 2 的对比度，1 到 21，前景背景对调结果相同 */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** OKLab 的 L、a、b（Björn Ottosson 的矩阵） */
export function oklab(color: string): [number, number, number] {
  const [r, g, b] = channels(color).map(linear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** 两个颜色在 OKLab 里的欧氏距离 */
export function oklabDistance(first: string, second: string): number {
  const a = oklab(first)
  const b = oklab(second)
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** 在 sRGB 里按 weight 把 color 混入 base（各通道四舍五入），结果小写 */
export function mix(color: string, base: string, weight: number): HexColor {
  const top = channels(color)
  const bottom = channels(base)
  const hex = top.map((channel, index) =>
    Math.round(channel * weight + bottom[index]! * (1 - weight))
      .toString(16)
      .padStart(2, '0'),
  )
  return `#${hex.join('')}`
}
