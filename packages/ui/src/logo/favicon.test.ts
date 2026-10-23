import { expect, it } from 'vitest'
import appleIconUrl from '../../../../apps/web/public/apple-icon.png?url'
import icoUrl from '../../../../apps/web/public/favicon.ico?url'
import iconSvg from '../../../../apps/web/public/icon.svg?raw'
import themeCss from '../theme.css?raw'
import { parseTheme } from '../tokens.ts'
import { renderFavicons } from './favicon.ts'
import { LOGO_MARK } from './mark.ts'

const favicons = renderFavicons(parseTheme(themeCss))
const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer())

// 改了 token 或标志的图形以后要运行 `pnpm design:sync`，否则站点图标和界面对不上（ADR-0032）
it('apps/web/public 里的默认站点图标与 token 和标志的图形一致', async () => {
  expect(iconSvg).toBe(favicons.svg)
  expect(await bytes(icoUrl)).toEqual(favicons.ico)
  expect(await bytes(appleIconUrl)).toEqual(favicons.appleIcon)
})

// 浏览器解码生成的 PNG，逐像素对照标志的图形：编码器是手写的，这一条守着它
it('ICO 里的 16px 图标每格 2 像素，前脸是亮色的强调色，透明处透明', async () => {
  const view = new DataView(favicons.ico.buffer)
  expect(view.getUint16(4, true)).toBe(3)
  const [length, offset] = [view.getUint32(6 + 8, true), view.getUint32(6 + 12, true)]
  const bitmap = await createImageBitmap(new Blob([favicons.ico.slice(offset, offset + length)], { type: 'image/png' }))
  const canvas = new OffscreenCanvas(16, 16)
  const context = canvas.getContext('2d')!
  context.drawImage(bitmap, 0, 0)
  const pixels = context.getImageData(0, 0, 16, 16).data
  const accent = parseTheme(themeCss).colors.find((color) => color.name === 'accent-fill')!.light
  const hex = (x: number, y: number) => {
    const i = (y * 16 + x) * 4
    return pixels[i + 3] === 0
      ? 'transparent'
      : `#${[pixels[i], pixels[i + 1], pixels[i + 2]].map((v) => v!.toString(16).padStart(2, '0')).join('')}`
  }
  expect(LOGO_MARK[0][0]).toBe('.')
  expect(hex(0, 0)).toBe('transparent')
  expect(LOGO_MARK[7][0]).toBe('a')
  expect(hex(1, 15)).toBe(accent)
})
