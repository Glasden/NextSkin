import type { Meta, StoryObj } from '@storybook/react-vite'
import decodeQR from 'qr/decode.js'
import { expect } from 'storybook/test'
import { QrCode } from './qr-code.tsx'

const uri =
  'otpauth://totp/NextSkin:steve%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=NextSkin&digits=6&period=30'

const meta = {
  title: 'Components/QrCode',
  component: QrCode,
  args: { value: uri, label: '两步验证的二维码' },
} satisfies Meta<typeof QrCode>

export default meta
type Story = StoryObj<typeof meta>

/** 把页面上的 SVG 按显示尺寸画到画布上，再解码：颜色取自主题，所以两种主题下都要能扫出原文 */
async function decodeRendered(svg: SVGSVGElement): Promise<string> {
  const copy = svg.cloneNode(true) as SVGSVGElement
  // 画成图片时没有页面的样式表，填充色先按计算结果写进属性
  const shapes = [...svg.querySelectorAll('rect, path')]
  ;[...copy.querySelectorAll('rect, path')].forEach((shape, index) =>
    shape.setAttribute('fill', getComputedStyle(shapes[index]!).fill),
  )
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = svg.width.baseVal.value
  canvas.height = svg.height.baseVal.value
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0)
  return decodeQR(context.getImageData(0, 0, canvas.width, canvas.height))
}

export const TotpUri: Story = {
  name: 'TOTP URI',
  play: async ({ canvas, args }) => {
    const svg = canvas.getByRole('img', { name: '两步验证的二维码' }) as unknown as SVGSVGElement
    // 每个模块 4px，四周留 4 个模块的静区
    await expect(svg.width.baseVal.value % 4).toBe(0)
    await expect(await decodeRendered(svg)).toBe(args.value)
  },
}

/** 短内容的版本小，二维码也小一些 */
export const Short: Story = {
  args: { value: 'https://skin.example.com', label: '站点地址' },
  play: async ({ canvas, args }) => {
    const svg = canvas.getByRole('img', { name: '站点地址' }) as unknown as SVGSVGElement
    await expect(await decodeRendered(svg)).toBe(args.value)
  },
}
