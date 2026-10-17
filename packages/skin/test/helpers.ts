import type { Rgba } from '../src/index.ts'

export function blank(width = 64, height = width): Rgba {
  return { width, height, data: new Uint8Array(width * height * 4) }
}

export function paint(image: Rgba, x: number, y: number, w: number, h: number, color: number[]): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) image.data.set(color, (yy * image.width + xx) * 4)
  }
}

export function pixel(image: Rgba, x: number, y: number): number[] {
  const p = (y * image.width + x) * 4
  return Array.from(image.data.slice(p, p + 4))
}

/** 坐标相关的非对称色和 alpha，包括透明 RGB；使镜像、取样与合成错误可见。 */
export function patterned(width: number, height: number): Rgba {
  const image = blank(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      image.data[p] = (x * 19 + y * 7) % 256
      image.data[p + 1] = (x * 3 + y * 23) % 256
      image.data[p + 2] = (x * 29 + y * 11) % 256
      image.data[p + 3] = (x * 13 + y * 17) % 256
    }
  }
  return image
}

export function samePixels(a: Rgba, b: Rgba): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.data.length === b.data.length &&
    a.data.every((value, i) => value === b.data[i])
  )
}
